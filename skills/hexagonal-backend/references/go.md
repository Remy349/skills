# Go reference

Go has no exceptions, no annotations and a strong idiom of small interfaces. Hexagonal architecture fits well, but it must look like Go: few layers, small packages, explicit wiring, no framework. Target Go 1.22+ (enhanced `net/http` routing) unless the project pins older.

## Contents
1. Detection and tooling
2. Naming and style conventions
3. Layout
4. Vertical slice example (PlaceOrder)
5. HTTP adapter and error mapping
6. Composition root and graceful shutdown
7. Errors
8. Persistence adapters
9. Testing
10. Pitfalls
11. Architecture enforcement

## 1. Detection and tooling

- Read `go.mod` for the module path and Go version. Router in use: standard `net/http` (`ServeMux` with method+path patterns since 1.22), `chi`, `gin`, `echo`, `fiber`. Prefer the standard library or `chi` for new services; keep the project's choice otherwise.
- Formatting is not negotiable: `gofmt`/`goimports`. Static checks: `go vet`, `golangci-lint` (with `errcheck`, `staticcheck`, `revive`, `gosec`, `depguard`). Race detector in CI: `go test -race ./...`.
- Persistence: `database/sql` + `pgx`, `sqlc` (type-safe generated queries), `sqlx`, `ent`, or GORM. Keep generated/ORM types inside the adapter.
- Logging: `log/slog` (structured, standard library).

## 2. Naming and style conventions

Follow *Effective Go*, the *Go Code Review Comments* and the Google Go Style Guide.

- Packages: short, lowercase, single word, no underscores or `mixedCaps`; the name describes what it provides, not its layer bucket. Avoid `util`, `common`, `models`, `helpers`, `base`. Avoid stutter: `orders.Service`, not `orders.OrdersService`; `postgres.OrderRepository`, not `postgres.PostgresOrderRepository`.
- Exported identifiers: `MixedCaps` (`PlaceOrder`); unexported: `mixedCaps`. Never `snake_case`. Acronyms keep case: `ID`, `URL`, `HTTP`, `orderID`, `httpClient`.
- Getters have no `Get` prefix: `order.ID()`, not `order.GetID()`. Setters, when needed, use `SetX`.
- Interfaces: small (1-3 methods), named by behavior (`Reader`, or `OrderRepository` for a domain port). **No `I` prefix, no `Impl` suffix.** One-method interfaces often take an `-er` name (`Authorizer`).
- **Accept interfaces, return structs.** Define an interface in the package that **consumes** it (the application package owns its ports), not next to the implementation. Do not define an interface until a consumer needs it.
- Constructors: `NewX(deps...) *X` (or `X` by value for small immutable types). Use functional options (`WithTimeout(...)`) for optional configuration.
- `context.Context` is the first parameter of anything doing I/O, named `ctx`; never store it in a struct.
- Errors: last return value; error strings are lowercase, no trailing punctuation; wrap with `%w`; sentinel errors named `ErrXxx`; custom error types named `XxxError`.
- Receivers: short (one or two letters, consistent), and consistently pointer or value for a given type.
- Doc comments on every exported identifier, starting with its name. Tests in `_test.go`; table-driven with `t.Run`.
- Comments and identifiers in English unless the project decides otherwise. Keep functions short, return early, avoid deep nesting (`if err != nil { return ... }` idiom).
- Zero values should be useful; avoid constructors that only exist to set defaults you can get for free.

## 3. Layout

Go rewards flat, package-per-responsibility structure under `internal/` (unexportable to other modules).

```
cmd/api/main.go                     # composition root: config, wiring, server, shutdown
internal/
  orders/
    domain/          order.go errors.go            # pure: stdlib only
    app/             place_order.go ports.go       # use cases + port interfaces
    adapters/
      httpapi/       handler.go dto.go errors.go   # inbound
      postgres/      order_repository.go           # outbound
      payments/      gateway.go                    # outbound (HTTP client to provider)
  platform/          config/ logger/ httpserver/ db/   # cross-cutting infrastructure
```

For small services a flatter form is idiomatic and acceptable: one `orders` package holding domain + use cases + ports, with `orders/httpapi` and `orders/postgres` as adapters. Split into `domain`/`app` when the domain grows or you want the compiler to enforce purity. Go forbids import cycles, which helps enforce the dependency rule naturally.

## 4. Vertical slice example (PlaceOrder)

```go
// internal/orders/domain/order.go
package domain

import "errors"

var ErrInvalidAmount = errors.New("amount must be positive")

type Order struct {
	id              string
	amountCents     int64
	status          Status
	authorizationID string
}

type Status string

const (
	StatusPending    Status = "pending"
	StatusAuthorized Status = "authorized"
)

// NewOrder creates a new pending order, enforcing its invariants.
func NewOrder(id string, amountCents int64) (Order, error) {
	if amountCents <= 0 {
		return Order{}, ErrInvalidAmount
	}
	return Order{id: id, amountCents: amountCents, status: StatusPending}, nil
}

// Rehydrate rebuilds an order from storage without re-running creation rules.
func Rehydrate(id string, amountCents int64, status Status, authorizationID string) Order {
	return Order{id: id, amountCents: amountCents, status: status, authorizationID: authorizationID}
}

func (o Order) ID() string              { return o.id }
func (o Order) AmountCents() int64      { return o.amountCents }
func (o Order) Status() Status          { return o.status }
func (o Order) AuthorizationID() string { return o.authorizationID }

func (o Order) MarkAuthorized(authorizationID string) Order {
	o.status = StatusAuthorized
	o.authorizationID = authorizationID
	return o
}
```

```go
// internal/orders/app/ports.go
package app

import (
	"context"
	"errors"

	"shop/internal/orders/domain"
)

var ErrOrderNotFound = errors.New("order not found")

// Outbound ports, owned by the application layer (the consumer).
type OrderRepository interface {
	Save(ctx context.Context, o domain.Order) error
	FindByID(ctx context.Context, id string) (domain.Order, error) // returns ErrOrderNotFound
}

type PaymentGateway interface {
	Authorize(ctx context.Context, orderID string, amountCents int64) (authorizationID string, err error)
}
```

```go
// internal/orders/app/place_order.go
package app

import (
	"context"
	"fmt"

	"shop/internal/orders/domain"
)

type PlaceOrderInput struct{ AmountCents int64 }
type PlaceOrderOutput struct{ OrderID, AuthorizationID string }

type PlaceOrder struct {
	orders   OrderRepository
	payments PaymentGateway
	newID    func() string
}

func NewPlaceOrder(orders OrderRepository, payments PaymentGateway, newID func() string) *PlaceOrder {
	return &PlaceOrder{orders: orders, payments: payments, newID: newID}
}

func (uc *PlaceOrder) Execute(ctx context.Context, in PlaceOrderInput) (PlaceOrderOutput, error) {
	order, err := domain.NewOrder(uc.newID(), in.AmountCents)
	if err != nil {
		return PlaceOrderOutput{}, fmt.Errorf("create order: %w", err)
	}
	authID, err := uc.payments.Authorize(ctx, order.ID(), order.AmountCents())
	if err != nil {
		return PlaceOrderOutput{}, fmt.Errorf("authorize payment: %w", err)
	}
	if err := uc.orders.Save(ctx, order.MarkAuthorized(authID)); err != nil {
		return PlaceOrderOutput{}, fmt.Errorf("save order: %w", err)
	}
	return PlaceOrderOutput{OrderID: order.ID(), AuthorizationID: authID}, nil
}
```

## 5. HTTP adapter and error mapping

The inbound adapter declares the (tiny) interface it needs; the concrete use case satisfies it implicitly. JSON tags live on the adapter DTOs, never on domain types.

```go
// internal/orders/adapters/httpapi/handler.go
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"shop/internal/orders/app"
)

type OrderPlacer interface {
	Execute(ctx context.Context, in app.PlaceOrderInput) (app.PlaceOrderOutput, error)
}

type Handler struct{ placeOrder OrderPlacer }

func NewHandler(placeOrder OrderPlacer) *Handler { return &Handler{placeOrder: placeOrder} }

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /orders", h.postOrder)
}

type placeOrderRequest struct {
	AmountCents int64 `json:"amountCents"`
}
type placeOrderResponse struct {
	OrderID         string `json:"orderId"`
	AuthorizationID string `json:"authorizationId"`
}

func (h *Handler) postOrder(w http.ResponseWriter, r *http.Request) {
	var req placeOrderRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "INVALID_JSON", "request body is not valid JSON")
		return
	}
	out, err := h.placeOrder.Execute(r.Context(), app.PlaceOrderInput{AmountCents: req.AmountCents})
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Location", "/orders/"+out.OrderID)
	writeJSON(w, http.StatusCreated, placeOrderResponse{OrderID: out.OrderID, AuthorizationID: out.AuthorizationID})
}
```

```go
// internal/orders/adapters/httpapi/errors.go
package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
)

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, domain.ErrInvalidAmount):
		writeProblem(w, r, http.StatusUnprocessableEntity, "ORDER_INVALID", err.Error())
	case errors.Is(err, app.ErrOrderNotFound):
		writeProblem(w, r, http.StatusNotFound, "ORDER_NOT_FOUND", "order not found")
	default:
		slog.ErrorContext(r.Context(), "unhandled error", "err", err, "path", r.URL.Path) // log once, here
		writeProblem(w, r, http.StatusInternalServerError, "INTERNAL", "internal server error")
	}
}
```

`writeProblem` and `writeJSON` are small helpers in the same package that set `Content-Type` (`application/problem+json` for problems) and encode the body. Use `errors.As` for typed errors that carry data (e.g. a `ValidationError` with field details). Go has no annotation-based validation: validate shape explicitly in the handler or with a library such as `go-playground/validator` on the request DTO.

## 6. Composition root and graceful shutdown

```go
// cmd/api/main.go
func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load() // reads env once, validates, returns a typed struct
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	repo := postgres.NewOrderRepository(pool)
	gateway := payments.NewGateway(cfg.PaymentsURL, &http.Client{Timeout: 5 * time.Second})
	placeOrder := app.NewPlaceOrder(repo, gateway, uuid.NewString)

	mux := http.NewServeMux()
	httpapi.NewHandler(placeOrder).Register(mux)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
```

No DI framework is needed in Go; explicit construction in `main` is the idiom. No `init()` wiring and no package-level mutable state. Cross-cutting HTTP concerns (request id, logging, recover, auth) are middleware `func(http.Handler) http.Handler` in the adapter/platform layer.

## 7. Errors

- Errors are values. Domain and application packages expose **sentinel errors** (`ErrOrderNotFound`) or **typed errors** (`type ConflictError struct{ ... }`). Callers use `errors.Is` / `errors.As`, never string comparison.
- Wrap with context using `fmt.Errorf("save order: %w", err)` when propagating up; do not wrap at every single frame if it adds no information. Do not both log and return the same error; log once at the boundary that handles it.
- Adapters translate technology errors: `pgconn.PgError` unique violation (code `23505`) → application `ErrConflict`; `sql.ErrNoRows` → `ErrOrderNotFound`; `context.DeadlineExceeded` stays wrapped.
- `panic` only for programmer errors; recover in HTTP middleware and return 500.

## 8. Persistence adapters

- The repository lives in `adapters/postgres`, uses `pgx`/`sqlc`/`database/sql`, and maps rows to domain values (`domain.Rehydrate(...)`). Row structs and `db:"..."` tags stay in the adapter.
- Always pass `ctx`; use `QueryRowContext`-style calls; close rows; check `rows.Err()`.
- Transactions: a `TxManager` port with `WithinTx(ctx, func(ctx context.Context) error) error` that carries the transaction via the context or a scoped repository set. The use case decides the boundary; the adapter implements begin/commit/rollback.
- Manage schema with migrations (`golang-migrate`, `goose`, `atlas`), applied in integration tests.

## 9. Testing

- Table-driven tests with `t.Run(tt.name, ...)`; `t.Parallel()` where state is isolated; `t.Helper()` in helpers; `t.Cleanup` for teardown; `go test -race`.
- Use case tests with hand-written fakes (`type fakeOrders struct{ saved []domain.Order }`) implementing the port. Hand-written fakes are idiomatic; use `testify` or generated mocks only if the project already does. Assert with plain comparisons or `cmp.Diff` (`go-cmp`).
- Inbound tests with `httptest.NewRecorder` / `httptest.NewServer`, injecting a fake `OrderPlacer`.
- Outbound integration tests with `testcontainers-go` (PostgreSQL) plus real migrations; stub external HTTP with `httptest.Server`.
- Fuzz tests (`testing.F`) for parsers and value objects; benchmarks only where performance matters.
- Freeze time by injecting `func() time.Time` or a `Clock` interface.

## 10. Pitfalls

- Defining interfaces on the producer side "for mocking" everywhere: leads to `IOrderService`-style ceremony. Define them at the consumer, and only when a second implementation or a fake needs them.
- Returning an interface instead of a concrete type from constructors; over-large interfaces.
- Typed-nil pitfall: a nil `*T` stored in an interface is not `== nil`. Return the interface's `nil` explicitly.
- Goroutine leaks and unbounded concurrency: tie every goroutine to a `ctx` and wait for it (`errgroup`); never spawn a goroutine per request without a limit.
- Ignoring `defer` in loops, unclosed response bodies, missing timeouts on `http.Client`/`http.Server`.
- JSON tags or DB tags on domain structs; exported mutable fields that bypass invariants (export fields only for simple data carriers).
- Shadowed `err`, `:=` inside `if` masking outer variables, comparing errors with `==` after wrapping.
- Global `var db *sql.DB`, `init()` side effects, package-level config.
- Deep package trees mirroring Java layering; prefer few cohesive packages.

## 11. Architecture enforcement

`depguard` in `.golangci.yml` (shown with the golangci-lint v1 layout; in v2 the same `depguard` block sits under `linters.settings`, so adapt it to the version the repo uses):

```yaml
linters:
  enable: [depguard, errcheck, staticcheck, govet, revive, gosec]
linters-settings:
  depguard:
    rules:
      domain-pure:
        files: ["**/internal/*/domain/**"]
        deny:
          - pkg: "net/http"
            desc: domain must not know HTTP
          - pkg: "database/sql"
            desc: domain must not know persistence
          - pkg: "github.com/jackc/pgx"
            desc: domain must not know drivers
          - pkg: "shop/internal/orders/adapters"
            desc: domain must not depend on adapters
      app-no-adapters:
        files: ["**/internal/*/app/**"]
        deny:
          - pkg: "shop/internal/orders/adapters"
            desc: application depends on ports only
```

Because Go forbids import cycles, the compiler already prevents domain→adapter cycles when adapters import the domain; `depguard` (or `go-arch-lint`) closes the remaining gaps such as `app` importing an adapter.
