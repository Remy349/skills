# Gin adapter guide

Scope: Gin 1.12 with its go-playground/validator binding. Covers the inbound adapter, central error mapping, the composition root and tests. The domain and use cases are the ones from `../idioms.md`; nothing here changes them.

## Contents
1. Detection
2. Where each Gin piece goes
3. Inbound adapter
4. Central error mapping
5. Composition root and graceful shutdown
6. Transactions and request-scoped resources
7. Testing the adapter
8. Pitfalls

## 1. Detection

`github.com/gin-gonic/gin` in `go.mod`; handlers with the signature `func(c *gin.Context)`.

## 2. Where each Gin piece goes

| Gin piece | Hexagonal role | Notes |
|---|---|---|
| `gin.Engine`, route groups | Inbound adapter (routing) | Routes registered by each context's `Handler.Register` |
| Handlers | Inbound adapter | Bind, call the use case, render |
| `binding:"..."` tags | Inbound adapter (edge) | Shape only, on request DTOs, never on domain types |
| Error middleware | Inbound adapter (central error mapping) | Handlers attach errors with `c.Error`; one middleware renders them |
| `gin.CustomRecovery` | Inbound adapter | Panics become a 500 problem |
| `cmd/api/main.go` | Composition root | A `*gin.Engine` is an `http.Handler`: same server and shutdown as net/http |

## 3. Inbound adapter

```go
// internal/orders/adapters/inbound/httpapi/dto.go
package httpapi

import "shop/internal/orders/app"

// Request DTOs carry Gin binding tags. Shape only: business rules stay in the domain.
type orderLineRequest struct {
	SKU            string `json:"sku" binding:"required,max=64"`
	Quantity       int    `json:"quantity" binding:"required,min=1,max=1000"`
	UnitPriceCents int64  `json:"unitPriceCents" binding:"min=0"`
}

type placeOrderRequest struct {
	CustomerID string             `json:"customerId" binding:"required,max=64"`
	Currency   string             `json:"currency" binding:"required,len=3,uppercase"`
	Lines      []orderLineRequest `json:"lines" binding:"required,min=1,max=100,dive"`
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

```go
// internal/orders/adapters/inbound/httpapi/handler.go
// Package httpapi is the HTTP inbound adapter of the orders context, on Gin.
package httpapi

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"

	"shop/internal/orders/app"
	"shop/internal/platform/ginx"
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

func (h *Handler) Register(r gin.IRouter) {
	r.POST("/orders", h.PlaceOrder)
}

func (h *Handler) PlaceOrder(c *gin.Context) {
	var req placeOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(ginx.BindError(err))
		return
	}

	out, err := h.placeOrder.Execute(c.Request.Context(), req.toInput())
	if err != nil {
		_ = c.Error(err) // mapped once, by ginx.Errors
		return
	}

	c.Header("Location", "/orders/"+out.OrderID)
	c.JSON(http.StatusCreated, placeOrderResponse{
		OrderID:    out.OrderID,
		TotalCents: out.TotalCents,
		Currency:   out.Currency,
	})
}
```

Recipes add routes with the same shape: `POST /orders/:id/cancellation` reads `c.Param("id")` and `c.GetHeader("If-Match")`, `GET /orders` binds `limit` and `cursor` with `c.ShouldBindQuery`, and `POST /orders` reads `c.GetHeader("Idempotency-Key")`.

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

Validation errors from go-playground/validator become one 400 problem with JSON field paths; the same package serves Echo and Fiber:

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

`ginx` configures the engine once and renders the last error a handler attached:

```go
// internal/platform/ginx/ginx.go
// Package ginx holds the Gin plumbing shared by every bounded context.
package ginx

import (
	"fmt"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"

	"shop/internal/platform/problem"
	"shop/internal/platform/validation"
)

// New builds an engine with strict JSON binding, JSON field names in validation errors,
// and the central error middleware. Call it once from the composition root.
func New(logger *slog.Logger) *gin.Engine {
	binding.EnableDecoderDisallowUnknownFields = true // no mass assignment
	if v, ok := binding.Validator.Engine().(*validator.Validate); ok {
		v.RegisterTagNameFunc(validation.JSONName)
	}

	engine := gin.New()
	engine.Use(
		Errors(logger),
		gin.CustomRecovery(func(c *gin.Context, recovered any) {
			_ = c.Error(fmt.Errorf("panic: %v", recovered))
			c.Abort()
		}),
	)
	return engine
}

// Errors maps the last error a handler attached with c.Error to Problem Details,
// in one place. Server-side failures are logged once, here.
func Errors(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if len(c.Errors) == 0 || c.Writer.Written() {
			return
		}
		err := c.Errors.Last().Err
		p := problem.FromError(err)
		if p.Status >= http.StatusInternalServerError {
			logger.ErrorContext(c.Request.Context(), "request failed",
				"err", err, "method", c.Request.Method, "path", c.Request.URL.Path)
		}
		p.Instance = c.Request.URL.Path
		c.Header("Content-Type", problem.ContentType) // kept by c.JSON
		c.JSON(p.Status, p)
	}
}

// BindError turns a ShouldBind error into a 400 problem: field errors when validation
// failed, a malformed-body problem otherwise.
func BindError(err error) error {
	if translated := validation.Translate(err); translated != err {
		return translated
	}
	return problem.MalformedBody(err)
}
```

- `binding.EnableDecoderDisallowUnknownFields` rejects fields the DTO does not declare: no mass assignment.
- The error middleware runs after the handler (`c.Next()` first) and writes only if nothing was written yet.
- Server-side failures (status 500+) are logged once, here, with the original error.
- Limit body size with `http.MaxBytesReader` in a middleware, or at the proxy.

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

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/orders"
	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/platform/config"
	"shop/internal/platform/ginx"
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

	gin.SetMode(gin.ReleaseMode)
	engine := ginx.New(logger)
	httpapi.NewHandler(ordersModule.PlaceOrder).Register(engine)
	engine.GET("/healthz", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           engine, // a Gin engine is an http.Handler: same server, timeouts and shutdown
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

`gin.New()` (inside `ginx.New`) starts without the default logger and recovery, so the middleware stack is explicit. `gin.SetMode(gin.ReleaseMode)` silences debug output in production. Serving through `http.Server` keeps the timeouts and `Shutdown` of the standard library; `engine.Run` has neither.

## 6. Transactions and request-scoped resources

Handlers never open transactions: the use case does, through the unit of work. Pass `c.Request.Context()` to use cases, not `c` itself: `*gin.Context` is recycled after the handler returns and must not reach the application layer or a goroutine (use `c.Copy()` if a goroutine truly needs it).

## 7. Testing the adapter

`httptest.NewRecorder` and `engine.ServeHTTP` run the real engine in memory:

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

	"github.com/gin-gonic/gin"

	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
	"shop/internal/platform/ginx"
	"shop/internal/platform/problem"
)

func newEngine(placeOrder httpapi.PlaceOrderUseCase) *gin.Engine {
	gin.SetMode(gin.TestMode)
	if placeOrder == nil {
		placeOrder = app.NewPlaceOrder(orderstest.NewFakeUnitOfWork(), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())
	}
	engine := ginx.New(slog.New(slog.DiscardHandler))
	httpapi.NewHandler(placeOrder).Register(engine)
	return engine
}

func post(engine *gin.Engine, body string) *httptest.ResponseRecorder {
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
	if want := `{"orderId":"order-1","totalCents":3000,"currency":"USD"}`; rec.Body.String() != want {
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

- **`binding` or `json` tags on domain types**, or binding the body straight into an aggregate: mass assignment and a domain shaped by the API.
- **`c.JSON(500, gin.H{"error": err.Error()})` in handlers**: scattered mapping and leaked internals. Attach with `c.Error(err)` and return.
- **`c.AbortWithStatusJSON` for business errors**: bypasses the central mapping; keep it for middleware that must stop the chain (auth).
- **Passing `*gin.Context` as a `context.Context`** into use cases: it satisfies the interface but carries Gin's lifecycle; use `c.Request.Context()`.
- **`gin.Default()` in production** without deciding what its logger and recovery should do.
- **`engine.Run(addr)`**: no timeouts and no graceful shutdown.
