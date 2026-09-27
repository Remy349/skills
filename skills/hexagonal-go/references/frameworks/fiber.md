# Fiber adapter guide

Scope: Fiber v3 (3.5), built on fasthttp rather than `net/http`. Covers the inbound adapter, central error mapping, the composition root and tests. The domain and use cases are the ones from `../idioms.md`; nothing here changes them, and that is the point: switching from Fiber to `net/http` touches only this adapter and `main.go`.

Fiber v3 handlers take `fiber.Ctx` (an interface; v2 used `*fiber.Ctx`), binding moved to `c.Bind().JSON(...)`, and graceful shutdown is part of `ListenConfig`. For a v2 project the design is the same with the v2 API.

## Contents
1. Detection
2. Where each Fiber piece goes
3. Inbound adapter
4. Central error mapping
5. Composition root and graceful shutdown
6. Transactions and request-scoped resources
7. Testing the adapter
8. Pitfalls

## 1. Detection

`github.com/gofiber/fiber/v3` (or `/v2`) in `go.mod`; handlers `func(c fiber.Ctx) error`.

## 2. Where each Fiber piece goes

| Fiber piece | Hexagonal role | Notes |
|---|---|---|
| `*fiber.App`, groups | Inbound adapter (routing) | Routes registered by each context's `Handler.Register` |
| Handlers | Inbound adapter | Bind, call the use case, render |
| `Config.StructValidator` | Inbound adapter (edge) | go-playground/validator on request DTOs; shape only |
| `Config.ErrorHandler` | Inbound adapter (central error mapping) | Handlers return errors; one function renders them |
| `Config.JSONDecoder` | Inbound adapter | Strict decoding: unknown fields rejected |
| `cmd/api/main.go` | Composition root | `app.Listen` with `GracefulContext` |

## 3. Inbound adapter

```go
// internal/orders/adapters/inbound/httpapi/dto.go
package httpapi

import "shop/internal/orders/app"

// Request DTOs carry validate tags, checked by the validator registered in fiberx.New.
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

```go
// internal/orders/adapters/inbound/httpapi/handler.go
// Package httpapi is the HTTP inbound adapter of the orders context, on Fiber v3.
package httpapi

import (
	"context"

	"github.com/gofiber/fiber/v3"

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

func (h *Handler) Register(r fiber.Router) {
	r.Post("/orders", h.PlaceOrder)
}

func (h *Handler) PlaceOrder(c fiber.Ctx) error {
	var req placeOrderRequest
	if err := c.Bind().JSON(&req); err != nil { // decodes, then runs the StructValidator
		return err
	}

	out, err := h.placeOrder.Execute(c.Context(), req.toInput())
	if err != nil {
		return err // mapped once, by fiberx.ErrorHandler
	}

	c.Location("/orders/" + out.OrderID)
	return c.Status(fiber.StatusCreated).JSON(placeOrderResponse{
		OrderID:    out.OrderID,
		TotalCents: out.TotalCents,
		Currency:   out.Currency,
	})
}
```

Recipes add routes with the same shape: `POST /orders/:id/cancellation` reads `c.Params("id")` and `c.Get("If-Match")`, `GET /orders` reads `c.Query("limit")` and `c.Query("cursor")`, and `POST /orders` reads `c.Get("Idempotency-Key")`.

Take identity from authentication, not from the body: an auth middleware stores the principal (`c.Locals`), and the handler copies it into the use case input.

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

Validation errors become one 400 problem with JSON field paths; `c.Bind().JSON` calls the validator after decoding:

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

`fiberx` configures the app once:

```go
// internal/platform/fiberx/fiberx.go
// Package fiberx holds the Fiber v3 plumbing shared by every bounded context.
package fiberx

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/recover"

	"shop/internal/platform/problem"
	"shop/internal/platform/validation"
)

// New builds a Fiber app for the hexagonal core. Call it once from the composition root.
func New(logger *slog.Logger) *fiber.App {
	app := fiber.New(fiber.Config{
		// Values read from the request stay valid after the handler returns. Fiber reuses
		// buffers by default, which is unsafe as soon as a string reaches a use case that keeps it.
		Immutable:       true,
		BodyLimit:       1 << 20,
		ReadTimeout:     15 * time.Second,
		WriteTimeout:    15 * time.Second,
		IdleTimeout:     60 * time.Second,
		JSONDecoder:     strictUnmarshal,
		StructValidator: validation.New(),
		ErrorHandler:    ErrorHandler(logger),
	})
	app.Use(recover.New())
	return app
}

// ErrorHandler maps every error a handler returns to Problem Details, in one place.
// Fiber's own errors (404 route, 405, 413) keep their status.
func ErrorHandler(logger *slog.Logger) fiber.ErrorHandler {
	return func(c fiber.Ctx, err error) error {
		p := problem.FromError(err)
		var bindErr *fiber.BindError
		var fiberErr *fiber.Error
		if p.Status == http.StatusInternalServerError {
			switch {
			case errors.As(err, &bindErr):
				p = problem.MalformedBody(bindErr.Err)
			case errors.As(err, &fiberErr) && fiberErr.Code < http.StatusInternalServerError:
				p = problem.New(fiberErr.Code, "", "")
			}
		}
		if p.Status >= http.StatusInternalServerError {
			logger.ErrorContext(c.Context(), "request failed", "err", err, "method", c.Method(), "path", c.Path())
		}
		p.Instance = c.Path()
		return c.Status(p.Status).JSON(p, problem.ContentType)
	}
}

// strictUnmarshal rejects unknown fields (no mass assignment) and trailing data.
func strictUnmarshal(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("body must contain a single JSON object")
	}
	return nil
}
```

- **`Immutable: true`** is the important line. By default Fiber reuses the request buffers after the handler returns, so a string from `c.Params`, `c.Get` or the body can change under a use case, a log line or a stored event that kept it. The copy costs a few allocations; debugging corrupted ids costs more.
- The error handler keeps the status of Fiber's own errors (unknown route, 405, 413) and maps decode failures (`*fiber.BindError`) to a malformed-body problem.
- Server-side failures (status 500+) are logged once, here, with the original error.

## 5. Composition root and graceful shutdown

```go
// cmd/api/main.go
// Command api is the composition root: it loads config, builds adapters and use cases,
// serves HTTP and shuts down gracefully.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/orders"
	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/platform/config"
	"shop/internal/platform/fiberx"
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

	app := fiberx.New(logger)
	httpapi.NewHandler(ordersModule.PlaceOrder).Register(app)
	app.Get("/healthz", func(c fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) })

	logger.Info("listening", "addr", cfg.HTTPAddr)
	// Listen returns when ctx is cancelled, after in-flight requests finish or the timeout expires.
	return app.Listen(cfg.HTTPAddr, fiber.ListenConfig{
		GracefulContext:       ctx,
		ShutdownTimeout:       cfg.ShutdownTimeout,
		DisableStartupMessage: true,
	})
}
```

`GracefulContext` makes `Listen` shut down when the signal context is cancelled, waiting for in-flight requests up to `ShutdownTimeout`.

## 6. Transactions and request-scoped resources

Handlers never open transactions: the use case does, through the unit of work. Pass `c.Context()` to use cases, never the `fiber.Ctx` itself: it is pooled and invalid after the handler returns.

fasthttp does not cancel `c.Context()` when the client disconnects. Bound the use case with the timeout middleware (`timeout.New(handler, timeout.Config{Timeout: 5 * time.Second})` from `github.com/gofiber/fiber/v3/middleware/timeout`) or a `context.WithTimeout` in the handler, so a slow query does not outlive the request forever.

## 7. Testing the adapter

Fiber is not an `http.Handler`; `app.Test(req)` runs a request in memory and returns an `*http.Response`:

```go
// internal/orders/adapters/inbound/httpapi/handler_test.go
package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v3"

	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
	"shop/internal/platform/fiberx"
	"shop/internal/platform/problem"
)

func newApp(placeOrder httpapi.PlaceOrderUseCase) *fiber.App {
	if placeOrder == nil {
		placeOrder = app.NewPlaceOrder(orderstest.NewFakeUnitOfWork(), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())
	}
	a := fiberx.New(slog.New(slog.DiscardHandler))
	httpapi.NewHandler(placeOrder).Register(a)
	return a
}

type response struct {
	status int
	header http.Header
	body   string
}

// send runs the request in memory with app.Test: Fiber is not an http.Handler.
func send(t *testing.T, a *fiber.App, method, path, body string) response {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := a.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{status: res.StatusCode, header: res.Header, body: string(raw)}
}

func post(t *testing.T, a *fiber.App, body string) response {
	t.Helper()
	return send(t, a, http.MethodPost, "/orders", body)
}

func decodeProblem(t *testing.T, res response) problem.Problem {
	t.Helper()
	var p problem.Problem
	if err := json.Unmarshal([]byte(res.body), &p); err != nil {
		t.Fatalf("%v: %s", err, res.body)
	}
	return p
}

const validBody = `{"customerId":"customer-1","currency":"USD","lines":[{"sku":"SKU-1","quantity":2,"unitPriceCents":1500}]}`

func TestPlaceOrderReturns201WithLocation(t *testing.T) {
	res := post(t, newApp(nil), validBody)

	if res.status != http.StatusCreated || res.header.Get("Location") != "/orders/order-1" {
		t.Fatalf("status = %d, location = %q", res.status, res.header.Get("Location"))
	}
	if want := `{"orderId":"order-1","totalCents":3000,"currency":"USD"}`; res.body != want {
		t.Fatalf("body = %s", res.body)
	}
}

func TestPlaceOrderReportsEveryShapeErrorAt400(t *testing.T) {
	res := post(t, newApp(nil), `{"customerId":"","currency":"usd","lines":[{"sku":"","quantity":0,"unitPriceCents":1}]}`)

	p := decodeProblem(t, res)
	if res.status != http.StatusBadRequest || res.header.Get("Content-Type") != problem.ContentType {
		t.Fatalf("status = %d, content type = %q", res.status, res.header.Get("Content-Type"))
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
	res := post(t, newApp(nil), `{"customerId":"c","currency":"USD","lines":[],"status":"paid"}`)

	if p := decodeProblem(t, res); res.status != http.StatusBadRequest || p.Code != "MALFORMED_BODY" {
		t.Fatalf("status = %d, problem = %+v", res.status, p)
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
			res := post(t, newApp(stubPlaceOrder{err: tt.err}), validBody)

			p := decodeProblem(t, res)
			if res.status != tt.wantStatus || p.Code != tt.wantCode {
				t.Fatalf("status = %d, problem = %+v", res.status, p)
			}
			if strings.Contains(res.body, "connection refused") {
				t.Fatalf("internal error leaked to the client: %s", res.body)
			}
		})
	}
}

func TestUnknownRouteKeepsFiberStatus(t *testing.T) {
	res := send(t, newApp(nil), http.MethodGet, "/missing", "")

	if p := decodeProblem(t, res); res.status != http.StatusNotFound || p.Status != 404 {
		t.Fatalf("status = %d, problem = %+v", res.status, p)
	}
}

func TestPanicsBecomeA500Problem(t *testing.T) {
	res := post(t, newApp(panickingPlaceOrder{}), validBody)

	if p := decodeProblem(t, res); res.status != http.StatusInternalServerError || p.Status != 500 {
		t.Fatalf("status = %d, problem = %+v", res.status, p)
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

- **Keeping values from `fiber.Ctx` after the handler returns** without `Immutable: true` (or `strings.Clone`): ids and headers change under your feet.
- **Passing `fiber.Ctx` into the application layer** or a goroutine.
- **Assuming `net/http` middleware works**: it needs `github.com/gofiber/fiber/v3/middleware/adaptor`. Prefer Fiber's own middleware.
- **`fiber.NewError(422, ...)` from handlers for business rules**: return the domain error and let the family mapping decide.
- **`app.Listen(addr)` without `GracefulContext`** and without read and write timeouts.
