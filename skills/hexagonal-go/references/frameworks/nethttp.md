# net/http (and chi) adapter guide

Scope: the standard library `net/http` with the Go 1.22+ `ServeMux` (method and wildcards in patterns), and chi v5, which mounts the same handlers. Covers the inbound adapter, central error mapping, the composition root with graceful shutdown, and tests. The domain and use cases are the ones from `../idioms.md`; nothing here changes them.

## Contents
1. Detection
2. Where each piece goes
3. Inbound adapter
4. Central error mapping
5. Composition root and graceful shutdown
6. Transactions and request-scoped resources
7. Testing the adapter
8. chi
9. Pitfalls

## 1. Detection

`net/http` handlers registered on `http.NewServeMux()` with patterns like `"POST /orders"`, and no web framework in `go.mod`. `github.com/go-chi/chi/v5` means chi (section 8). For gorilla/mux, httprouter or others, apply "Integrating a framework without a dedicated guide" in `SKILL.md`; the handler shape below still works because they all accept `http.Handler`.

## 2. Where each piece goes

| Piece | Hexagonal role | Notes |
|---|---|---|
| `ServeMux` / chi router | Inbound adapter (routing) | Routes registered by each context's `Handler.Register` |
| Handler methods | Inbound adapter | Decode, validate shape, call the use case, encode |
| `validate()` on request DTOs | Inbound adapter (edge) | Shape only; business rules stay in the domain |
| `httpx.Adapter` | Inbound adapter (central error mapping) | One place turns errors into Problem Details |
| `cmd/api/main.go` | Composition root | Config, pool, modules, server timeouts, shutdown |
| Middleware (`func(http.Handler) http.Handler`) | Inbound adapter (cross-cutting) | Request id, auth, logging, recovery |

## 3. Inbound adapter

Request and response DTOs belong to the adapter, with the mapping to the use case input and a hand-written shape check that reports every error at once:

```go
// internal/orders/adapters/inbound/httpapi/dto.go
package httpapi

import (
	"fmt"
	"regexp"

	"shop/internal/orders/app"
	"shop/internal/platform/problem"
)

type orderLineRequest struct {
	SKU            string `json:"sku"`
	Quantity       int    `json:"quantity"`
	UnitPriceCents int64  `json:"unitPriceCents"`
}

type placeOrderRequest struct {
	CustomerID string             `json:"customerId"`
	Currency   string             `json:"currency"`
	Lines      []orderLineRequest `json:"lines"`
}

var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

// validate checks the request shape and reports every error at once.
// Business rules (one currency per order, at least one line) stay in the domain.
func (r placeOrderRequest) validate() []problem.FieldError {
	var errs []problem.FieldError
	add := func(field, message string) { errs = append(errs, problem.FieldError{Field: field, Message: message}) }

	if r.CustomerID == "" || len(r.CustomerID) > 64 {
		add("customerId", "must be 1 to 64 characters")
	}
	if !currencyPattern.MatchString(r.Currency) {
		add("currency", "must be a 3-letter ISO 4217 code")
	}
	if len(r.Lines) == 0 || len(r.Lines) > 100 {
		add("lines", "must contain 1 to 100 lines")
	}
	for i, line := range r.Lines {
		if line.SKU == "" || len(line.SKU) > 64 {
			add(fmt.Sprintf("lines[%d].sku", i), "must be 1 to 64 characters")
		}
		if line.Quantity < 1 || line.Quantity > 1000 {
			add(fmt.Sprintf("lines[%d].quantity", i), "must be between 1 and 1000")
		}
		if line.UnitPriceCents < 0 {
			add(fmt.Sprintf("lines[%d].unitPriceCents", i), "must not be negative")
		}
	}
	return errs
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

Handlers return their error instead of writing it. The adapter depends on the use case through a small interface declared here, in the consumer:

```go
// internal/orders/adapters/inbound/httpapi/handler.go
// Package httpapi is the HTTP inbound adapter of the orders context, on net/http.
package httpapi

import (
	"context"
	"net/http"

	"shop/internal/orders/app"
	"shop/internal/platform/httpx"
	"shop/internal/platform/problem"
)

// PlaceOrderUseCase is what this adapter needs from the application layer. Declaring it here,
// in the consumer, lets tests pass a stub and lets a decorator wrap the use case.
type PlaceOrderUseCase interface {
	Execute(ctx context.Context, in app.PlaceOrderInput) (app.PlaceOrderOutput, error)
}

type Handler struct {
	placeOrder PlaceOrderUseCase
}

func NewHandler(placeOrder PlaceOrderUseCase) *Handler {
	return &Handler{placeOrder: placeOrder}
}

// Register mounts the routes on a ServeMux or a chi router.
func (h *Handler) Register(r httpx.Router, adapter httpx.Adapter) {
	r.Handle("POST /orders", adapter.Handle(h.PlaceOrder))
}

func (h *Handler) PlaceOrder(w http.ResponseWriter, r *http.Request) error {
	var req placeOrderRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	if errs := req.validate(); len(errs) > 0 {
		return problem.Validation(errs)
	}

	out, err := h.placeOrder.Execute(r.Context(), req.toInput())
	if err != nil {
		return err // mapped once, by the adapter
	}

	w.Header().Set("Location", "/orders/"+out.OrderID)
	return httpx.WriteJSON(w, http.StatusCreated, placeOrderResponse{
		OrderID:    out.OrderID,
		TotalCents: out.TotalCents,
		Currency:   out.Currency,
	})
}
```

Recipes add routes with the same shape: `POST /orders/{id}/cancellation` reads `r.PathValue("id")` and `If-Match`, `GET /orders` reads `limit` and `cursor` from `r.URL.Query()`, and `POST /orders` accepts an `Idempotency-Key` header.

Take identity from authentication, not from the body: in production `customerId` comes from a middleware that validates the token and stores a principal in the request context; the handler copies it into the use case input.

## 4. Central error mapping

Problem Details are built by a framework-neutral package that maps the error **families** of the shared kernel, so every context and every framework share it:

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

`httpx` adapts error-returning handlers and is the one place where errors become responses. It also holds the strict JSON decoder:

```go
// internal/platform/httpx/httpx.go
// Package httpx holds the net/http plumbing shared by every bounded context:
// error-returning handlers, JSON decoding and Problem Details responses.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"shop/internal/platform/problem"
)

// Router is satisfied by *http.ServeMux (Go 1.22+) and by chi v5 routers: both accept
// "METHOD /path/{wildcard}" patterns and expose wildcards through r.PathValue.
type Router interface {
	Handle(pattern string, handler http.Handler)
}

// HandlerFunc is a handler that returns its error instead of writing it.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Adapter turns HandlerFuncs into http.Handlers and maps every returned error to Problem
// Details in one place. Server-side failures are logged once, here; unexpected errors reach
// the client only as a generic 500.
type Adapter struct {
	logger *slog.Logger
}

func NewAdapter(logger *slog.Logger) Adapter {
	return Adapter{logger: logger}
}

func (a Adapter) Handle(fn HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		err := fn(w, r)
		if err == nil {
			return
		}
		p := problem.FromError(err)
		if p.Status >= http.StatusInternalServerError {
			a.logger.ErrorContext(r.Context(), "request failed", "err", err, "method", r.Method, "path", r.URL.Path)
		}
		p.Instance = r.URL.Path
		w.Header().Set("Content-Type", problem.ContentType)
		w.WriteHeader(p.Status)
		_ = json.NewEncoder(w).Encode(p)
	})
}

const maxBodyBytes = 1 << 20

// DecodeJSON reads one JSON object and rejects unknown fields (no mass assignment),
// bodies over 1 MiB and trailing data. Failures are returned as a 400 problem.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if err == nil && dec.More() {
		err = errors.New("body must contain a single JSON object")
	}
	if err != nil {
		return problem.MalformedBody(fmt.Errorf("invalid JSON body: %w", err))
	}
	return nil
}

func WriteJSON(w http.ResponseWriter, status int, body any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(body)
}
```

- `DisallowUnknownFields` rejects fields the DTO does not declare: no mass assignment.
- `http.MaxBytesReader` bounds the body; the server timeouts in section 5 bound slow clients.
- Server-side failures (status 500+) are logged once, here, with the original error. The client gets a generic body for unexpected errors.

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

	"shop/internal/orders"
	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/platform/config"
	"shop/internal/platform/httpx"
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

	mux := http.NewServeMux()
	httpapi.NewHandler(ordersModule.PlaceOrder).Register(mux, httpx.NewAdapter(logger))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           mux,
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

- `signal.NotifyContext` turns SIGTERM (what Kubernetes and most platforms send) into context cancellation.
- `server.Shutdown` stops accepting connections and waits for in-flight requests, bounded by `SHOP_SHUTDOWN_TIMEOUT`. Deferred `pool.Close()` runs after it.
- Always set `ReadHeaderTimeout` (Slowloris) and the other timeouts; the zero values mean "no timeout".
- Add a readiness endpoint that pings the pool if the platform routes traffic by readiness.

## 6. Transactions and request-scoped resources

Handlers never open transactions: the use case does, through the unit of work. Per-request values (principal, request id, deadline) travel in `r.Context()`, which the handler passes to `Execute`; cancellation then reaches the database driver. Do not put request-scoped objects in structs shared by all requests.

## 7. Testing the adapter

`httptest` runs the real mux in memory. Use the real use case with fakes for the happy path, and a stub use case to drive each error family:

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

	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
	"shop/internal/platform/httpx"
	"shop/internal/platform/problem"
)

// newServer uses the real use case with fakes: the test covers the adapter and its mapping.
func newServer(t *testing.T, placeOrder httpapi.PlaceOrderUseCase) *httptest.Server {
	t.Helper()
	if placeOrder == nil {
		placeOrder = app.NewPlaceOrder(orderstest.NewFakeUnitOfWork(), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())
	}
	mux := http.NewServeMux()
	httpapi.NewHandler(placeOrder).Register(mux, httpx.NewAdapter(slog.New(slog.DiscardHandler)))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func post(t *testing.T, server *httptest.Server, body string) (*http.Response, []byte) {
	t.Helper()
	res, err := http.Post(server.URL+"/orders", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, raw
}

const validBody = `{"customerId":"customer-1","currency":"USD","lines":[{"sku":"SKU-1","quantity":2,"unitPriceCents":1500}]}`

func TestPlaceOrderReturns201WithLocation(t *testing.T) {
	res, body := post(t, newServer(t, nil), validBody)

	if res.StatusCode != http.StatusCreated || res.Header.Get("Location") != "/orders/order-1" {
		t.Fatalf("status = %d, location = %q", res.StatusCode, res.Header.Get("Location"))
	}
	if want := `{"orderId":"order-1","totalCents":3000,"currency":"USD"}`; strings.TrimSpace(string(body)) != want {
		t.Fatalf("body = %s", body)
	}
}

func TestPlaceOrderReportsEveryShapeErrorAt400(t *testing.T) {
	res, body := post(t, newServer(t, nil), `{"customerId":"","currency":"usd","lines":[{"sku":"","quantity":0,"unitPriceCents":1}]}`)

	var p problem.Problem
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusBadRequest || res.Header.Get("Content-Type") != problem.ContentType {
		t.Fatalf("status = %d, content type = %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	if p.Code != "VALIDATION_FAILED" || len(p.Errors) != 4 {
		t.Fatalf("problem = %+v", p)
	}
}

func TestPlaceOrderRejectsUnknownFields(t *testing.T) {
	res, _ := post(t, newServer(t, nil), `{"customerId":"c","currency":"USD","lines":[],"status":"paid"}`)

	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.StatusCode)
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
			res, body := post(t, newServer(t, stubPlaceOrder{err: tt.err}), validBody)

			var p problem.Problem
			if err := json.Unmarshal(body, &p); err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != tt.wantStatus || p.Code != tt.wantCode {
				t.Fatalf("status = %d, problem = %+v", res.StatusCode, p)
			}
			if tt.wantStatus == 500 && strings.Contains(string(body), "connection refused") {
				t.Fatalf("internal error leaked to the client: %s", body)
			}
		})
	}
}

type stubPlaceOrder struct{ err error }

func (s stubPlaceOrder) Execute(context.Context, app.PlaceOrderInput) (app.PlaceOrderOutput, error) {
	return app.PlaceOrderOutput{}, s.err
}
```

## 8. chi

chi v5 routers accept the same `"METHOD /path/{id}"` patterns in `Handle` and set wildcards with `r.SetPathValue`, so handlers read `r.PathValue("id")` on both routers and `Register` takes a tiny interface (`httpx.Router`). chi adds route groups and middleware such as `middleware.RequestID`, `middleware.Recoverer`, `middleware.Timeout`:

```go
// internal/orders/adapters/inbound/httpapi/chi_test.go
package httpapi_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"shop/internal/orders/adapters/inbound/httpapi"
	"shop/internal/orders/app"
	"shop/internal/orders/orderstest"
	"shop/internal/platform/httpx"
)

func TestTheSameHandlerMountsOnChi(t *testing.T) {
	placeOrder := app.NewPlaceOrder(orderstest.NewFakeUnitOfWork(), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Recoverer)
	httpapi.NewHandler(placeOrder).Register(r, httpx.NewAdapter(slog.New(slog.DiscardHandler)))
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/orders", strings.NewReader(validBody)))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}
```

In `main.go`, build `chi.NewRouter()`, `Use` the middleware, and pass the router to `Register` and to `http.Server.Handler`; everything else stays the same.

## 9. Pitfalls

- **Business logic in handlers**: an `if order.Status == ...` in a handler moves into the aggregate or the use case.
- **Decoding straight into a domain type** or a struct with more fields than the endpoint accepts: mass assignment. Decode into a request DTO and map.
- **`http.Error` or `w.WriteHeader` scattered in handlers** with ad hoc bodies: return an error and let `httpx.Adapter` map it.
- **`http.ListenAndServe` with the default server**: no timeouts, no graceful shutdown.
- **`http.DefaultServeMux` and `init()` registrations**: global state; build the mux in `main`.
- **Using `context.Background()` in a handler** instead of `r.Context()`: cancelled requests keep running queries.
- **Leaking error details**: never write `err.Error()` of an unexpected error to the client.
