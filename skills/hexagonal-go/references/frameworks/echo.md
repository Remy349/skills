# Echo adapter guide

Scope: Echo v5 (5.3). Covers the inbound adapter, central error mapping, the composition root and tests. The domain and use cases are the ones from `../idioms.md`; nothing here changes them.

Echo v5 changed the handler signature: `func(c *echo.Context) error` (a struct pointer, not the v4 `echo.Context` interface), and `HTTPErrorHandler` is `func(c *echo.Context, err error)`. For a v4 project (`github.com/labstack/echo/v4`), the design below is identical; use the v4 signatures.

## Contents
1. Detection
2. Where each Echo piece goes
3. Inbound adapter
4. Central error mapping
5. Composition root and graceful shutdown
6. Transactions and request-scoped resources
7. Testing the adapter
8. Pitfalls

## 1. Detection

`github.com/labstack/echo/v5` (or `/v4`) in `go.mod`; handlers returning `error`.

## 2. Where each Echo piece goes

| Echo piece | Hexagonal role | Notes |
|---|---|---|
| `*echo.Echo`, groups | Inbound adapter (routing) | Routes registered by each context's `Handler.Register` |
| Handlers | Inbound adapter | Bind, validate, call the use case, render |
| `e.Validator` | Inbound adapter (edge) | go-playground/validator on request DTOs; shape only |
| `e.HTTPErrorHandler` | Inbound adapter (central error mapping) | Handlers return errors; one function renders them |
| `e.JSONSerializer` | Inbound adapter | Strict decoding: unknown fields rejected |
| `cmd/api/main.go` | Composition root | `*echo.Echo` is an `http.Handler`: same server and shutdown as net/http |

## 3. Inbound adapter

```go
// internal/orders/adapters/inbound/httpapi/dto.go
package httpapi

import "shop/internal/orders/app"

// Request DTOs carry validate tags, checked by the validator registered in echox.New.
// Shape only: business rules stay in the domain.
type orderLineRequest struct {
	SKU            string `json:"sku" validate:"required,max=64"`
	Quantity       int    `json:"quantity" validate:"required,min=1,max=1000"`
	UnitPriceCents int64  `json:"unitPriceCents" validate:"min=0"`
}

type placeOrderRequest struct {
	CustomerID string             `json:"customerId" validate:"required,max=64"`
	Currency   string             `json:"currency" validate:"required,len=3,uppercase"`
	Lines      []orderLineRequest `json:"lines" validate:"required,min=1,max=100,dive"`
}

func (r placeOrderRequest) toInput() app.PlaceOrderInput {
	lines := make([]app.PlaceOrderLine, len(r.Lines))
	for i, l := range r.Lines {
		lines[i] = app.PlaceOrderLine{SKU: l.SKU, Quantity: l.Quantity, UnitPriceCents: l.UnitPriceCents}
	}
	return app.PlaceOrderInput{CustomerID: r.CustomerID, Currency: r.Currency, Lines: lines}
}

type placeOrderResponse struct {
	OrderID    string `json:"orderId"`
	TotalCents int64  `json:"totalCents"`
	Currency   string `json:"currency"`
}
```

`echo.BindBody` binds only the body. `c.Bind` also binds path parameters (fields tagged `param`) and, for GET, DELETE and HEAD, query parameters (`query`) into the same struct: convenient for reads, but for commands keep one source per DTO.

```go
// internal/orders/adapters/inbound/httpapi/handler.go
// Package httpapi is the HTTP inbound adapter of the orders context, on Echo v5.
package httpapi

import (
	"context"
	"net/http"

	"github.com/labstack/echo/v5"

	"shop/internal/orders/app"
)

// PlaceOrderUseCase is what this adapter needs from the application layer.
type PlaceOrderUseCase interface {
	Execute(ctx context.Context, in app.PlaceOrderInput) (app.PlaceOrderOutput, error)
}

type Handler struct {
	placeOrder PlaceOrderUseCase
}

func NewHandler(placeOrder PlaceOrderUseCase) *Handler {
	return &Handler{placeOrder: placeOrder}
}

func (h *Handler) Register(e *echo.Echo) {
	e.POST("/orders", h.PlaceOrder)
}

func (h *Handler) PlaceOrder(c *echo.Context) error {
	var req placeOrderRequest
	if err := echo.BindBody(c, &req); err != nil {
		return err
	}
	if err := c.Validate(&req); err != nil {
		return err
	}

	out, err := h.placeOrder.Execute(c.Request().Context(), req.toInput())
	if err != nil {
		return err // mapped once, by echox.ErrorHandler
	}

	c.Response().Header().Set("Location", "/orders/"+out.OrderID)
	return c.JSON(http.StatusCreated, placeOrderResponse{
		OrderID:    out.OrderID,
		TotalCents: out.TotalCents,
		Currency:   out.Currency,
	})
}
```

Recipes add routes with the same shape: `POST /orders/:id/cancellation` reads `c.Param("id")` and the `If-Match` header, `GET /orders` reads `c.QueryParam("limit")` and `c.QueryParam("cursor")`, and `POST /orders` reads the `Idempotency-Key` header.

Take identity from authentication, not from the body: an auth middleware stores the principal (`c.Set`), and the handler copies it into the use case input.

## 4. Central error mapping

Problem Details are built by a framework-neutral package that maps the error **families** of the shared kernel:

```go
// internal/platform/problem/problem.go
// Package problem builds RFC 9457 Problem Details bodies. It maps the error families of the
// shared kernel, so it serves every bounded context and every web framework.
package problem

import (
	"errors"
	"net/http"

	"shop/internal/sharedkernel"
)

const ContentType = "application/problem+json"

// Problem is the JSON error body. Code is the stable, machine-readable error code.
// It implements error, so an adapter can return a request error like any other error.
type Problem struct {
	Type     string       `json:"type"`
	Title    string       `json:"title"`
	Status   int          `json:"status"`
	Detail   string       `json:"detail,omitempty"`
	Instance string       `json:"instance,omitempty"`
	Code     string       `json:"code,omitempty"`
	Errors   []FieldError `json:"errors,omitempty"`
}

func (p Problem) Error() string { return p.Detail }

type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// New builds a problem with the standard title for the status.
func New(status int, code, detail string) Problem {
	return Problem{Type: "about:blank", Title: http.StatusText(status), Status: status, Code: code, Detail: detail}
}

// FromError maps a returned error to a problem: a Problem is used as is, a business error
// is mapped by family, and anything else is a 500 with a generic body. Callers log every
// problem with status 500 or more, once.
func FromError(err error) Problem {
	var p Problem
	if errors.As(err, &p) {
		return p
	}
	var business *sharedkernel.Error
	if !errors.As(err, &business) {
		return New(http.StatusInternalServerError, "", "")
	}
	return New(statusFor(business.Kind), business.Code, err.Error())
}

// Validation reports every request shape error at once.
func Validation(errs []FieldError) Problem {
	p := New(http.StatusBadRequest, "VALIDATION_FAILED", "request validation failed")
	p.Errors = errs
	return p
}

// MalformedBody reports a body that is not valid JSON for the endpoint.
func MalformedBody(err error) Problem {
	return New(http.StatusBadRequest, "MALFORMED_BODY", err.Error())
}

func statusFor(kind sharedkernel.Kind) int {
	switch kind {
	case sharedkernel.KindNotFound:
		return http.StatusNotFound
	case sharedkernel.KindConflict:
		return http.StatusConflict
	case sharedkernel.KindUnavailable:
		return http.StatusServiceUnavailable
	default:
		return http.StatusUnprocessableEntity
	}
}
```

Validation errors become one 400 problem with JSON field paths:

```go
// internal/platform/validation/validation.go
// Package validation checks request DTOs with go-playground/validator and reports
// every failure at once, with JSON field paths, as a 400 problem.
package validation

import (
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/go-playground/validator/v10"

	"shop/internal/platform/problem"
)

// Validator satisfies the validator hooks of Echo (Validate) and Fiber (StructValidator).
type Validator struct {
	validate *validator.Validate
}

func New() *Validator {
	v := validator.New(validator.WithRequiredStructEnabled())
	v.RegisterTagNameFunc(JSONName)
	return &Validator{validate: v}
}

func (v *Validator) Validate(dto any) error {
	return Translate(v.validate.Struct(dto))
}

// JSONName makes error paths use the JSON field names clients send.
func JSONName(field reflect.StructField) string {
	name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
	if name == "-" {
		return ""
	}
	if name == "" {
		return field.Name
	}
	return name
}

// Translate turns validator errors into a validation problem and returns other errors unchanged.
func Translate(err error) error {
	var invalid validator.ValidationErrors
	if !errors.As(err, &invalid) {
		return err
	}
	fields := make([]problem.FieldError, 0, len(invalid))
	for _, fe := range invalid {
		_, path, _ := strings.Cut(fe.Namespace(), ".") // drop the root struct name
		fields = append(fields, problem.FieldError{Field: path, Message: message(fe)})
	}
	return problem.Validation(fields)
}

func message(fe validator.FieldError) string {
	switch fe.Tag() {
	case "required":
		return "is required"
	case "min", "gte":
		return "must be at least " + fe.Param()
	case "max", "lte":
		return "must be at most " + fe.Param()
	case "len":
		return "must have length " + fe.Param()
	default:
		if fe.Param() == "" {
			return "must satisfy " + fe.Tag()
		}
		return fmt.Sprintf("must satisfy %s=%s", fe.Tag(), fe.Param())
	}
}
```

`echox` configures Echo once: strict JSON, the validator, recovery, a body limit and the error handler:

```go
// internal/platform/echox/echox.go
// Package echox holds the Echo v5 plumbing shared by every bounded context.
package echox

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"

	"shop/internal/platform/problem"
	"shop/internal/platform/validation"
)

// New builds an Echo instance with strict JSON binding, struct validation, panic recovery,
// a body limit and the central error handler. Call it once from the composition root.
func New(logger *slog.Logger) *echo.Echo {
	e := echo.New()
	e.Logger = logger
	e.JSONSerializer = strictJSON{}
	e.Validator = validation.New()
	e.HTTPErrorHandler = ErrorHandler(logger)
	e.Use(middleware.Recover(), middleware.BodyLimit(1<<20))
	return e
}

// ErrorHandler maps every error a handler returns to Problem Details, in one place.
// Echo's own errors (404 route, 405, 413, bind failures) keep their status.
func ErrorHandler(logger *slog.Logger) echo.HTTPErrorHandler {
	return func(c *echo.Context, err error) {
		if r, _ := echo.UnwrapResponse(c.Response()); r != nil && r.Committed {
			return
		}
		p := problem.FromError(err)
		var coder echo.HTTPStatusCoder
		if p.Status == http.StatusInternalServerError && errors.As(err, &coder) && coder.StatusCode() < http.StatusInternalServerError {
			p = problem.New(coder.StatusCode(), "", "")
		}
		if p.Status >= http.StatusInternalServerError {
			logger.ErrorContext(c.Request().Context(), "request failed",
				"err", err, "method", c.Request().Method, "path", c.Request().URL.Path)
		}
		p.Instance = c.Request().URL.Path
		c.Response().Header().Set(echo.HeaderContentType, problem.ContentType)
		if err := c.JSON(p.Status, p); err != nil {
			logger.ErrorContext(c.Request().Context(), "write error response", "err", err)
		}
	}
}

// strictJSON rejects unknown fields and trailing data; Echo's default serializer accepts both.
type strictJSON struct {
	echo.DefaultJSONSerializer
}

func (strictJSON) Deserialize(c *echo.Context, target any) error {
	var body bytes.Buffer
	if _, err := body.ReadFrom(c.Request().Body); err != nil {
		return problem.MalformedBody(err)
	}
	dec := json.NewDecoder(&body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return problem.MalformedBody(err)
	}
	if dec.More() {
		return problem.MalformedBody(errors.New("body must contain a single JSON object"))
	}
	return nil
}
```

- The error handler keeps the status of Echo's own errors (unknown route 404, 405, 413 from the body limit) and maps everything else by family.
- It returns early when the response is already committed.
- Server-side failures (status 500+) are logged once, here, with the original error.

## 5. Composition root and graceful shutdown

```go
// cmd/api/main.go
// Command api is the composition root: it loads config, builds adapters and use cases,
// serves HTTP and shuts down gracefully.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v5"

	"shop/internal/orders"
	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/platform/config"
	"shop/internal/platform/echox"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("service stopped", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("create database pool: %w", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("reach database: %w", err)
	}

	ordersModule := orders.NewModule(pool)

	e := echox.New(logger)
	httpapi.NewHandler(ordersModule.PlaceOrder).Register(e)
	e.GET("/healthz", func(c *echo.Context) error { return c.NoContent(http.StatusNoContent) })

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           e, // *echo.Echo is an http.Handler: same server, timeouts and shutdown
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.HTTPAddr)
		serveErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	return server.Shutdown(shutdownCtx) // stops accepting, waits for in-flight requests
}
```

Serving through `http.Server` keeps explicit timeouts and `Shutdown`. Echo's `echo.StartConfig{Address: ..., GracefulTimeout: ...}.Start(ctx, e)` is an alternative that also shuts down when `ctx` is cancelled.

## 6. Transactions and request-scoped resources

Handlers never open transactions: the use case does, through the unit of work. Pass `c.Request().Context()` to use cases; `*echo.Context` is pooled and must not reach the application layer or outlive the handler.

## 7. Testing the adapter

`httptest.NewRecorder` and `e.ServeHTTP` run the real instance in memory:

```go
// internal/orders/adapters/inbound/httpapi/handler_test.go
package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"

	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
	"shop/internal/platform/echox"
	"shop/internal/platform/problem"
)

func newEngine(placeOrder httpapi.PlaceOrderUseCase) *echo.Echo {
	if placeOrder == nil {
		placeOrder = app.NewPlaceOrder(orderstest.NewFakeUnitOfWork(), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())
	}
	e := echox.New(slog.New(slog.DiscardHandler))
	httpapi.NewHandler(placeOrder).Register(e)
	return e
}

func post(engine *echo.Echo, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/orders", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(rec, req)
	return rec
}

func decodeProblem(t *testing.T, rec *httptest.ResponseRecorder) problem.Problem {
	t.Helper()
	var p problem.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("%v: %s", err, rec.Body)
	}
	return p
}

const validBody = `{"customerId":"customer-1","currency":"USD","lines":[{"sku":"SKU-1","quantity":2,"unitPriceCents":1500}]}`

func TestPlaceOrderReturns201WithLocation(t *testing.T) {
	rec := post(newEngine(nil), validBody)

	if rec.Code != http.StatusCreated || rec.Header().Get("Location") != "/orders/order-1" {
		t.Fatalf("status = %d, location = %q", rec.Code, rec.Header().Get("Location"))
	}
	if want := `{"orderId":"order-1","totalCents":3000,"currency":"USD"}`; strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("body = %s", rec.Body)
	}
}

func TestPlaceOrderReportsEveryShapeErrorAt400(t *testing.T) {
	rec := post(newEngine(nil), `{"customerId":"","currency":"usd","lines":[{"sku":"","quantity":0,"unitPriceCents":1}]}`)

	p := decodeProblem(t, rec)
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Content-Type") != problem.ContentType {
		t.Fatalf("status = %d, content type = %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	fields := make([]string, len(p.Errors))
	for i, e := range p.Errors {
		fields[i] = e.Field
	}
	if want := "customerId currency lines[0].sku lines[0].quantity"; strings.Join(fields, " ") != want {
		t.Fatalf("fields = %v, want %s", fields, want)
	}
}

func TestPlaceOrderRejectsUnknownFields(t *testing.T) {
	rec := post(newEngine(nil), `{"customerId":"c","currency":"USD","lines":[],"status":"paid"}`)

	if p := decodeProblem(t, rec); rec.Code != http.StatusBadRequest || p.Code != "MALFORMED_BODY" {
		t.Fatalf("status = %d, problem = %+v", rec.Code, p)
	}
}

func TestPlaceOrderMapsErrorFamiliesToStatuses(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"business rule", fmt.Errorf("%w: an order needs at least one line", domain.ErrInvalidOrder), 422, "ORDER_INVALID"},
		{"not found", fmt.Errorf("%w: order-9", domain.ErrOrderNotFound), 404, "ORDER_NOT_FOUND"},
		{"conflict", domain.ErrDuplicateOrder, 409, "ORDER_DUPLICATE"},
		{"unexpected", errors.New("connection refused"), 500, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(newEngine(stubPlaceOrder{err: tt.err}), validBody)

			p := decodeProblem(t, rec)
			if rec.Code != tt.wantStatus || p.Code != tt.wantCode {
				t.Fatalf("status = %d, problem = %+v", rec.Code, p)
			}
			if strings.Contains(rec.Body.String(), "connection refused") {
				t.Fatalf("internal error leaked to the client: %s", rec.Body)
			}
		})
	}
}

func TestUnknownRouteKeepsEchoStatus(t *testing.T) {
	rec := httptest.NewRecorder()
	newEngine(nil).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/missing", nil))

	if p := decodeProblem(t, rec); rec.Code != http.StatusNotFound || p.Status != 404 {
		t.Fatalf("status = %d, problem = %+v", rec.Code, p)
	}
}

func TestPanicsBecomeA500Problem(t *testing.T) {
	rec := post(newEngine(panickingPlaceOrder{}), validBody)

	if p := decodeProblem(t, rec); rec.Code != http.StatusInternalServerError || p.Status != 500 {
		t.Fatalf("status = %d, problem = %+v", rec.Code, p)
	}
}

type stubPlaceOrder struct{ err error }

func (s stubPlaceOrder) Execute(context.Context, app.PlaceOrderInput) (app.PlaceOrderOutput, error) {
	return app.PlaceOrderOutput{}, s.err
}

type panickingPlaceOrder struct{}

func (panickingPlaceOrder) Execute(context.Context, app.PlaceOrderInput) (app.PlaceOrderOutput, error) {
	panic("boom")
}
```

## 8. Pitfalls

- **Returning `echo.NewHTTPError(422, ...)` from handlers for business rules**: the status decision belongs to the family mapping. Return the domain error.
- **The default JSON serializer** accepts unknown fields: register a strict one, as in `echox`.
- **One DTO bound from several sources** with `c.Bind`: path, query and body values compete for the same fields. Use `echo.BindBody` for command bodies and read path and query values explicitly.
- **`e.Start(addr)`** without timeouts or signal handling in production.
- **Mixing v4 and v5 examples**: the handler signature differs (`echo.Context` vs `*echo.Context`); check `go.mod`.
