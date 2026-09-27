# Go idioms, layout and the base slice

Targets Go 1.26+ (range over integers and functions, `min`/`max`, `errors.Join`, multiple `%w`, `context.WithoutCancel`, `slices`/`maps`, enhanced `net/http` routing). Nothing in the domain or the application layer imports a web framework, a driver or an ORM: this file is the core every framework guide and recipe builds on.

## Contents
1. Tooling
2. Naming and style
3. Layout
4. Base vertical slice: PlaceOrder
5. Composition root
6. Errors
7. Context and concurrency
8. Pitfalls
9. Architecture enforcement

## 1. Tooling

- **Module**: read `go.mod` for the module path and the `go` directive; keep them. Examples here use the module path `shop`.
- **Format**: `gofmt` (or `goimports`) is not negotiable. Imports in three groups: standard library, third party, this module.
- **Static checks**: `go vet` and `golangci-lint` v2 (its `standard` set includes `errcheck`, `govet`, `staticcheck`, `ineffassign`, `unused`). `depguard` enforces the dependency rule (section 9).
- **Tests**: `go test -race ./...`; integration tests behind a build tag (`testing.md`).
- **Security**: `govulncheck ./...` in CI.
- **Logging**: `log/slog`, structured, created in `main` and injected.

## 2. Naming and style

Follow *Effective Go*, *Go Code Review Comments* and the Google Go Style Guide.

- **Packages** are short, lowercase, single words named for what they provide: `domain`, `app`, `postgres`, `httpapi`. Never `util`, `common`, `helpers`, `models`, `base`. Avoid stutter: `postgres.OrderRepository`, not `postgres.PostgresOrderRepository`.
- **Identifiers**: `MixedCaps` exported, `mixedCaps` unexported, never `snake_case`. Initialisms keep one case: `OrderID`, `HTTPAddr`, `SKU`, `customerID`.
- **Getters** have no `Get` prefix: `order.Status()`, not `order.GetStatus()`.
- **Interfaces** are small, named for behavior, **defined by the consumer** (the application package owns its ports), with no `I` prefix and no `Impl` suffix. **Accept interfaces, return structs.**
- **Use cases** are verbs with one `Execute` method: `PlaceOrder`, `CancelOrder`. **Ports** are capabilities: `OrderRepository`, `PaymentGateway`, `Clock`. **Adapters** carry the technology in the package name: `postgres.OrderRepository`, `payments.Gateway`. **Fakes** say what they are: `InMemoryOrderRepository`, `FixedClock`.
- **Constructors** are `NewX(deps...) *X`. Dependencies go in as parameters, not through setters or globals.
- **Value objects** are structs with unexported fields, a validating constructor and value receivers; they are comparable with `==`. **Aggregates** are pointers with unexported fields and intention-revealing methods.
- **Ids** are defined types (`type OrderID string`), closed sets are typed string constants, money is integer minor units, time is `time.Time` in UTC from an injected `Clock`.
- **Errors** are the last return value, lowercase, without punctuation; sentinels are `ErrX`; wrap with `%w` (section 6).
- Doc comments on exported identifiers start with the name. Return early; keep the happy path unindented.

## 3. Layout

Feature first (bounded context), then layer. Everything under `internal/`, so no other module can import it.

```
cmd/api/main.go                     # composition root: config, adapters, server, shutdown
internal/
  sharedkernel/errors.go            # error families shared by all contexts (tiny, stable)
  orders/                           # bounded context
    domain/                         # money.go, order.go, events.go, errors.go: stdlib + shared kernel only
    app/                            # ports.go, unit_of_work.go, one file per use case
    adapters/
      inbound/httpapi/              # handlers, request DTOs, validation
      outbound/
        postgres/                   # repository, unit of work, outbox (pgx, sqlc or GORM)
        payments/                   # HTTP client to the payment provider (ACL)
        system/                     # UUID generator, system clock
    orderstest/                     # fakes, builders and contract suites for tests
    module.go                       # builds this context's use cases from concrete adapters
  catalog/                          # another context, same shape, or a thin slice
  platform/                         # cross-cutting plumbing: config, problem details, httpx, pgtest
migrations/                         # SQL migrations, embedded
```

Go refuses import cycles, so the compiler already stops `domain` from importing `app`. `depguard` (section 9) covers the rest: third-party imports in the core and adapters importing each other. For a very small service a flatter shape is idiomatic (one `orders` package with domain and use cases, plus `orders/postgres` and `orders/httpapi`); split when the domain grows.

## 4. Base vertical slice: PlaceOrder

The recipes extend this slice. The shared kernel declares the error **families**; inbound adapters map families, not individual errors, so adding an error to a context never touches an adapter.

```go
// internal/sharedkernel/errors.go
// Package sharedkernel holds the few types every bounded context shares. Keep it tiny and stable.
package sharedkernel

// Kind is the family of an expected error. Inbound adapters map kinds to protocol
// statuses, so adding an error to a context never touches an adapter.
type Kind uint8

const (
	KindInvalid     Kind = iota + 1 // a business rule rejects the request
	KindNotFound                    // the target does not exist
	KindConflict                    // the request conflicts with the current state
	KindUnavailable                 // a dependency is temporarily down; the client may retry
)

// Error is an expected failure: a business outcome or a retryable unavailability.
// Code is stable and part of the API contract. Declare each one once as a sentinel
// and wrap it with fmt.Errorf("%w: ...") to add detail.
type Error struct {
	Kind    Kind
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Invalid declares an error for a violated business rule.
func Invalid(code, message string) *Error {
	return &Error{Kind: KindInvalid, Code: code, Message: message}
}

// NotFound declares an error for a missing resource.
func NotFound(code, message string) *Error {
	return &Error{Kind: KindNotFound, Code: code, Message: message}
}

// Conflict declares an error for a duplicate, a stale version or a forbidden transition.
func Conflict(code, message string) *Error {
	return &Error{Kind: KindConflict, Code: code, Message: message}
}

// Unavailable declares an expected, retryable failure of a dependency the use case needs.
func Unavailable(code, message string) *Error {
	return &Error{Kind: KindUnavailable, Code: code, Message: message}
}
```

Each context declares its errors once, as sentinels:

```go
// internal/orders/domain/errors.go
package domain

import "shop/internal/sharedkernel"

var (
	ErrInvalidMoney      = sharedkernel.Invalid("MONEY_INVALID", "invalid money")
	ErrInvalidOrder      = sharedkernel.Invalid("ORDER_INVALID", "invalid order")
	ErrOrderNotFound     = sharedkernel.NotFound("ORDER_NOT_FOUND", "order not found")
	ErrDuplicateOrder    = sharedkernel.Conflict("ORDER_DUPLICATE", "order already exists")
	ErrInvalidTransition = sharedkernel.Conflict("ORDER_INVALID_TRANSITION", "invalid order transition")
	ErrStaleOrder        = sharedkernel.Conflict("ORDER_STALE", "order was modified concurrently")
)
```

Domain code wraps a sentinel to add detail: `fmt.Errorf("%w: quantity must be positive", ErrInvalidOrder)`. Callers check with `errors.Is(err, domain.ErrInvalidOrder)`; adapters find the family with `errors.As(err, &*sharedkernel.Error)`.

```go
// internal/orders/domain/money.go
package domain

import "fmt"

// Money is an amount in minor units (cents) plus an ISO 4217 currency code. Never a float.
// The zero value is not valid money; build it with NewMoney.
type Money struct {
	amount   int64
	currency string
}

// NewMoney validates the amount and the currency code.
func NewMoney(amount int64, currency string) (Money, error) {
	if amount < 0 {
		return Money{}, fmt.Errorf("%w: amount must not be negative", ErrInvalidMoney)
	}
	if !isCurrencyCode(currency) {
		return Money{}, fmt.Errorf("%w: invalid currency code %q", ErrInvalidMoney, currency)
	}
	return Money{amount: amount, currency: currency}, nil
}

func (m Money) Amount() int64    { return m.amount }
func (m Money) Currency() string { return m.currency }

// Add returns the sum of two amounts in the same currency.
func (m Money) Add(other Money) (Money, error) {
	if other.currency != m.currency {
		return Money{}, fmt.Errorf("%w: cannot add %s to %s", ErrInvalidMoney, other.currency, m.currency)
	}
	return Money{amount: m.amount + other.amount, currency: m.currency}, nil
}

// Times multiplies the amount by a non-negative quantity.
func (m Money) Times(quantity int) Money {
	return Money{amount: m.amount * int64(quantity), currency: m.currency}
}

func isCurrencyCode(code string) bool {
	if len(code) != 3 {
		return false
	}
	for _, r := range code {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}
```

The aggregate records domain events as facts; publishing them reliably is the job of `recipes/domain-events-outbox.md`.

```go
// internal/orders/domain/events.go
package domain

import "time"

// Event is a business fact recorded by an aggregate. Adapters translate events into
// integration events; the domain never publishes them itself.
type Event interface {
	EventName() string
}

type OrderPlaced struct {
	OrderID    OrderID
	CustomerID string
	Total      Money
	OccurredAt time.Time
}

type OrderPaid struct {
	OrderID    OrderID
	PaymentID  string
	OccurredAt time.Time
}

type OrderCancelled struct {
	OrderID    OrderID
	Reason     string
	OccurredAt time.Time
}

func (OrderPlaced) EventName() string    { return "OrderPlaced" }
func (OrderPaid) EventName() string      { return "OrderPaid" }
func (OrderCancelled) EventName() string { return "OrderCancelled" }
```

```go
// internal/orders/domain/order.go
// Package domain holds the orders model. It imports only the standard library and the shared kernel.
package domain

import (
	"fmt"
	"slices"
	"time"
)

type OrderID string

type Status string

const (
	StatusPending   Status = "pending"
	StatusPaid      Status = "paid"
	StatusCancelled Status = "cancelled"
)

// OrderLine is a value object: comparable, immutable, valid by construction.
type OrderLine struct {
	sku       string
	quantity  int
	unitPrice Money
}

func NewOrderLine(sku string, quantity int, unitPrice Money) (OrderLine, error) {
	if sku == "" {
		return OrderLine{}, fmt.Errorf("%w: sku is required", ErrInvalidOrder)
	}
	if quantity <= 0 {
		return OrderLine{}, fmt.Errorf("%w: quantity must be positive", ErrInvalidOrder)
	}
	return OrderLine{sku: sku, quantity: quantity, unitPrice: unitPrice}, nil
}

func (l OrderLine) SKU() string      { return l.sku }
func (l OrderLine) Quantity() int    { return l.quantity }
func (l OrderLine) UnitPrice() Money { return l.unitPrice }
func (l OrderLine) Subtotal() Money  { return l.unitPrice.Times(l.quantity) }

// Order is the aggregate root. Build it with NewOrder (applies business rules)
// or RehydrateOrder (loads stored state). Fields are unexported: state changes
// only through intention-revealing methods.
type Order struct {
	id         OrderID
	customerID string
	lines      []OrderLine
	status     Status
	placedAt   time.Time
	version    int
	paymentID  string
	events     []Event
}

// NewOrder places a new pending order and records OrderPlaced.
func NewOrder(id OrderID, customerID string, lines []OrderLine, now time.Time) (*Order, error) {
	if len(lines) == 0 {
		return nil, fmt.Errorf("%w: an order needs at least one line", ErrInvalidOrder)
	}
	for _, line := range lines[1:] {
		if line.unitPrice.currency != lines[0].unitPrice.currency {
			return nil, fmt.Errorf("%w: all lines must use the same currency", ErrInvalidOrder)
		}
	}
	order := &Order{
		id:         id,
		customerID: customerID,
		lines:      slices.Clone(lines),
		status:     StatusPending,
		placedAt:   now,
	}
	order.record(OrderPlaced{OrderID: id, CustomerID: customerID, Total: order.Total(), OccurredAt: now})
	return order, nil
}

// OrderSnapshot is the stored state of an order. Persistence adapters and fakes
// use it to map to and from their own models; the domain never persists itself.
type OrderSnapshot struct {
	ID         OrderID
	CustomerID string
	Lines      []OrderLine
	Status     Status
	PlacedAt   time.Time
	Version    int
	PaymentID  string
}

// RehydrateOrder rebuilds an order from storage without re-running creation rules
// and without recording events.
func RehydrateOrder(s OrderSnapshot) *Order {
	return &Order{
		id:         s.ID,
		customerID: s.CustomerID,
		lines:      slices.Clone(s.Lines),
		status:     s.Status,
		placedAt:   s.PlacedAt,
		version:    s.Version,
		paymentID:  s.PaymentID,
	}
}

// Snapshot returns a copy of the state to persist. Pending events are not part of it.
func (o *Order) Snapshot() OrderSnapshot {
	return OrderSnapshot{
		ID:         o.id,
		CustomerID: o.customerID,
		Lines:      slices.Clone(o.lines),
		Status:     o.status,
		PlacedAt:   o.placedAt,
		Version:    o.version,
		PaymentID:  o.paymentID,
	}
}

func (o *Order) ID() OrderID         { return o.id }
func (o *Order) CustomerID() string  { return o.customerID }
func (o *Order) Lines() []OrderLine  { return slices.Clone(o.lines) }
func (o *Order) Status() Status      { return o.status }
func (o *Order) PlacedAt() time.Time { return o.placedAt }
func (o *Order) PaymentID() string   { return o.paymentID }

// Version is the stored version this order was loaded with, used for optimistic concurrency.
func (o *Order) Version() int { return o.version }

// Total is the sum of the line subtotals. Lines share one currency by construction.
func (o *Order) Total() Money {
	total := Money{currency: o.lines[0].unitPrice.currency}
	for _, line := range o.lines {
		total.amount += line.Subtotal().amount
	}
	return total
}

// Pay marks a pending order as paid.
func (o *Order) Pay(paymentID string, now time.Time) error {
	if err := o.ensureStatus(StatusPending, "pay"); err != nil {
		return err
	}
	o.status = StatusPaid
	o.paymentID = paymentID
	o.record(OrderPaid{OrderID: o.id, PaymentID: paymentID, OccurredAt: now})
	return nil
}

// Cancel cancels a pending order.
func (o *Order) Cancel(reason string, now time.Time) error {
	if err := o.ensureStatus(StatusPending, "cancel"); err != nil {
		return err
	}
	o.status = StatusCancelled
	o.record(OrderCancelled{OrderID: o.id, Reason: reason, OccurredAt: now})
	return nil
}

// PullEvents returns the events recorded since the last call and forgets them.
func (o *Order) PullEvents() []Event {
	events := o.events
	o.events = nil
	return events
}

func (o *Order) ensureStatus(expected Status, action string) error {
	if o.status != expected {
		return fmt.Errorf("%w: cannot %s an order that is %s", ErrInvalidTransition, action, o.status)
	}
	return nil
}

func (o *Order) record(event Event) {
	o.events = append(o.events, event)
}
```

`OrderSnapshot` is the one door between the aggregate and persistence: adapters map rows to a snapshot and call `RehydrateOrder`, and map `Snapshot()` back to rows. Nothing outside the aggregate can assign `status` or `lines`.

Ports belong to the application layer and speak domain types:

```go
// internal/orders/app/ports.go
// Package app holds the orders use cases and the ports they need. It imports
// the domain and the standard library only; adapters implement the ports.
package app

import (
	"context"
	"time"

	"shop/internal/orders/domain"
)

// OrderRepository is the collection of orders, seen from the use cases.
type OrderRepository interface {
	// Get returns domain.ErrOrderNotFound when no order has the id.
	Get(ctx context.Context, id domain.OrderID) (*domain.Order, error)
	// Add inserts a new order. It returns domain.ErrDuplicateOrder when the id exists.
	Add(ctx context.Context, order *domain.Order) error
	// Update persists changes. It returns domain.ErrStaleOrder when the stored
	// version is no longer order.Version().
	Update(ctx context.Context, order *domain.Order) error
}

type IDGenerator interface {
	NewID() string
}

type Clock interface {
	Now() time.Time
}
```

The unit of work takes a function: the adapter opens a transaction, hands the function repositories bound to it, commits on `nil` and rolls back otherwise. Use cases never see a transaction object.

```go
// internal/orders/app/unit_of_work.go
package app

import "context"

// Tx gives access to the repositories of one transaction.
type Tx interface {
	Orders() OrderRepository
}

// UnitOfWork runs fn in one transaction. It commits when fn returns nil and
// rolls back when fn returns an error or panics.
type UnitOfWork interface {
	Do(ctx context.Context, fn func(tx Tx) error) error
}
```

```go
// internal/orders/app/place_order.go
package app

import (
	"context"

	"shop/internal/orders/domain"
)

type PlaceOrderLine struct {
	SKU            string
	Quantity       int
	UnitPriceCents int64
}

type PlaceOrderInput struct {
	CustomerID string
	Currency   string
	Lines      []PlaceOrderLine
}

type PlaceOrderOutput struct {
	OrderID    string
	TotalCents int64
	Currency   string
}

// PlaceOrder is built once at startup and is safe for concurrent use:
// every call opens its own unit of work.
type PlaceOrder struct {
	uow   UnitOfWork
	ids   IDGenerator
	clock Clock
}

func NewPlaceOrder(uow UnitOfWork, ids IDGenerator, clock Clock) *PlaceOrder {
	return &PlaceOrder{uow: uow, ids: ids, clock: clock}
}

func (uc *PlaceOrder) Execute(ctx context.Context, in PlaceOrderInput) (PlaceOrderOutput, error) {
	lines := make([]domain.OrderLine, 0, len(in.Lines))
	for _, l := range in.Lines {
		price, err := domain.NewMoney(l.UnitPriceCents, in.Currency)
		if err != nil {
			return PlaceOrderOutput{}, err
		}
		line, err := domain.NewOrderLine(l.SKU, l.Quantity, price)
		if err != nil {
			return PlaceOrderOutput{}, err
		}
		lines = append(lines, line)
	}
	order, err := domain.NewOrder(domain.OrderID(uc.ids.NewID()), in.CustomerID, lines, uc.clock.Now())
	if err != nil {
		return PlaceOrderOutput{}, err
	}

	err = uc.uow.Do(ctx, func(tx Tx) error {
		return tx.Orders().Add(ctx, order)
	})
	if err != nil {
		return PlaceOrderOutput{}, err
	}

	total := order.Total()
	return PlaceOrderOutput{OrderID: string(order.ID()), TotalCents: total.Amount(), Currency: total.Currency()}, nil
}
```

Use cases return domain errors unwrapped: they already describe the failure, and the HTTP adapter shows the message as the problem `detail`. Adapters wrap *infrastructure* errors with context (`fmt.Errorf("insert order %s: %w", id, err)`).

The slice is testable now, before any adapter exists. The fakes and builders live in `orderstest` (full versions in `testing.md`):

```go
// internal/orders/app/place_order_test.go
package app_test

import (
	"context"
	"errors"
	"testing"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
)

func newPlaceOrder() (*app.PlaceOrder, *orderstest.FakeUnitOfWork) {
	uow := orderstest.NewFakeUnitOfWork()
	return app.NewPlaceOrder(uow, &orderstest.SequentialIDs{}, orderstest.NewFixedClock()), uow
}

func TestPlaceOrderStoresAPendingOrderAndReturnsItsTotal(t *testing.T) {
	placeOrder, uow := newPlaceOrder()

	out, err := placeOrder.Execute(context.Background(), orderstest.PlaceOrderInput())

	if err != nil {
		t.Fatal(err)
	}
	if want := (app.PlaceOrderOutput{OrderID: "order-1", TotalCents: 3000, Currency: "USD"}); out != want {
		t.Fatalf("output = %+v, want %+v", out, want)
	}
	stored, err := uow.Committed.Get(context.Background(), "order-1")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status() != domain.StatusPending || uow.Commits != 1 {
		t.Fatalf("status = %s, commits = %d", stored.Status(), uow.Commits)
	}
}

func TestPlaceOrderRejectsAnOrderWithoutLinesAndStoresNothing(t *testing.T) {
	placeOrder, uow := newPlaceOrder()
	in := orderstest.PlaceOrderInput()
	in.Lines = nil

	_, err := placeOrder.Execute(context.Background(), in)

	if !errors.Is(err, domain.ErrInvalidOrder) {
		t.Fatalf("err = %v, want ErrInvalidOrder", err)
	}
	if len(uow.Committed.Rows) != 0 || uow.Commits != 0 {
		t.Fatalf("stored %d orders in %d commits", len(uow.Committed.Rows), uow.Commits)
	}
}
```

## 5. Composition root

Small infrastructure adapters for the `IDGenerator` and `Clock` ports:

```go
// internal/orders/adapters/outbound/system/system.go
// Package system implements the IDGenerator and Clock ports.
package system

import (
	"time"

	"github.com/google/uuid"
)

// UUIDGenerator returns UUIDv7 strings: unique and roughly time-ordered, which keeps B-tree indexes compact.
type UUIDGenerator struct{}

func (UUIDGenerator) NewID() string { return uuid.Must(uuid.NewV7()).String() }

type Clock struct{}

// Now is truncated to microseconds, the precision of PostgreSQL timestamptz, so an aggregate
// in memory and the same aggregate reloaded from the database agree.
func (Clock) Now() time.Time { return time.Now().UTC().Truncate(time.Microsecond) }
```

With Go 1.27+ the standard library `uuid` package (`uuid.NewV7()`) replaces `github.com/google/uuid`.

Each context exposes one constructor that turns infrastructure handles into ready-to-use use cases. It is the only package of the context that imports concrete adapters, and it knows nothing about the web framework:

```go
// internal/orders/module.go
// Package orders wires the orders context. It is the only package of the context that
// imports concrete adapters, and it knows nothing about the web framework.
package orders

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/orders/adapters/outbound/postgres"
	"shop/internal/orders/adapters/outbound/system"
	"shop/internal/orders/app"
)

// Module holds the use cases of the context. Build it once at startup; use cases are safe for concurrent use.
type Module struct {
	PlaceOrder *app.PlaceOrder
}

func NewModule(pool *pgxpool.Pool) Module {
	uow := postgres.NewUnitOfWork(pool)
	return Module{
		PlaceOrder: app.NewPlaceOrder(uow, system.UUIDGenerator{}, system.Clock{}),
	}
}
```

`cmd/api/main.go` loads the config, opens the pool, calls `NewModule` for each context, hands the use cases to the inbound adapters, serves and shuts down gracefully. Each framework guide shows its `main.go`.

Configuration is typed and validated once:

```go
// internal/platform/config/config.go
// Package config loads and validates settings once at startup.
package config

import (
	"errors"
	"fmt"
	"os"
	"time"
)

type Config struct {
	DatabaseURL     string
	HTTPAddr        string
	ShutdownTimeout time.Duration
}

// Load reads SHOP_* environment variables. The service refuses to start with invalid config.
func Load() (Config, error) {
	cfg := Config{
		DatabaseURL:     os.Getenv("SHOP_DATABASE_URL"),
		HTTPAddr:        envOr("SHOP_HTTP_ADDR", ":8080"),
		ShutdownTimeout: 10 * time.Second,
	}
	var errs []error
	if cfg.DatabaseURL == "" {
		errs = append(errs, errors.New("SHOP_DATABASE_URL is required"))
	}
	if raw := os.Getenv("SHOP_SHUTDOWN_TIMEOUT"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			errs = append(errs, fmt.Errorf("SHOP_SHUTDOWN_TIMEOUT must be a positive duration, got %q", raw))
		}
		cfg.ShutdownTimeout = d
	}
	return cfg, errors.Join(errs...)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

For many settings, `github.com/caarlos0/env/v11` or `github.com/kelseyhightower/envconfig` fill the struct from tags; keep them in `platform/config` and keep the validation.

## 6. Errors

- **Expected failures are values**, not panics: every business outcome is a sentinel `*sharedkernel.Error` with a stable `Code` and a `Kind` (invalid 422, not found 404, conflict 409, unavailable 503). `sharedkernel.Unavailable` covers a dependency that is down, such as a payment provider (`recipes/external-api-acl.md`).
- **Wrap, do not replace.** `fmt.Errorf("%w: detail", ErrX)` keeps the sentinel visible to `errors.Is`; `fmt.Errorf("%w: %w", ErrPaymentUnavailable, err)` keeps both the family and the transport cause.
- **Adapters translate** technology errors (`pgx.ErrNoRows`, unique violation `23505`, `gorm.ErrDuplicatedKey`, a client timeout) into the context's sentinels, and wrap anything unexpected with context.
- **Check with `errors.Is` / `errors.As`**, never with `==` on a wrapped error or with string matching.
- **Handle once.** Return errors up to the inbound adapter, which maps them in one place and logs server-side failures once. Do not log and return the same error.
- **Panics** are for programmer errors. The HTTP layer recovers them into a generic 500; the domain never panics on user input.

## 7. Context and concurrency

- `context.Context` is the first parameter of every method that does I/O, named `ctx`. Never store it in a struct. Pass the request context from the inbound adapter down to the driver so cancellation and deadlines reach the database.
- Use cases are built once at startup and shared by all requests: keep them **stateless** (dependencies only) so they are safe for concurrent use. Per-request state lives in local variables and in the unit of work.
- Set a timeout on every outbound network call (`http.Client{Timeout: ...}`, `context.WithTimeout`) in the adapter or the composition root.
- For work that must finish even if the client disconnects (releasing an idempotency key), use `context.WithoutCancel(ctx)`.
- Goroutines started by a use case must be owned: prefer `errgroup.Group` with the request context; never fire and forget.

## 8. Pitfalls

- **Anemic structs with exported fields** as domain entities: anyone can set `order.Status = "paid"`. Unexported fields and methods keep invariants enforceable.
- **ORM or JSON tags on domain types** (`gorm:"..."`, `json:"..."`): the domain now changes when the database or the API changes. Map in adapters.
- **Interfaces declared next to their implementation** (`postgres.OrderRepositoryInterface`): the consumer owns the interface.
- **`interface{}`/`any` in ports**, or a generic `Repository[T]` that exposes CRUD for every table: ports speak the domain.
- **Global state**: package-level `*sql.DB`, `init()` that connects, singletons. Build everything in `main` and pass it down.
- **Ignoring `ctx`** (`context.Background()` inside a use case) or ignoring errors (`_ = repo.Add(...)`).
- **Returning `nil, nil`** for "not found": return a sentinel error.
- **Naive time and float money**: `time.Now()` inside the domain, `float64` amounts.
- **`util`, `common`, `helpers` packages**: name packages after what they provide.

## 9. Architecture enforcement

`golangci-lint` with `depguard` fails CI when a layer imports what it must not. Run it next to `go vet` and the tests:

```yaml
# .golangci.yml
version: "2"

linters:
  enable:
    - depguard
  settings:
    depguard:
      rules:
        domain-is-pure:
          list-mode: strict
          files:
            - "**/internal/*/domain/**"
            - "!$test"
          allow:
            - $gostd
            - shop/internal/sharedkernel
        orders-app-depends-only-on-its-domain:
          list-mode: strict
          files:
            - "**/internal/orders/app/**"
            - "!$test"
          allow:
            - $gostd
            - shop/internal/sharedkernel
            - shop/internal/orders/domain
        inbound-adapters-do-not-import-outbound:
          files:
            - "**/internal/orders/adapters/inbound/**"
            - "!$test"
          deny:
            - pkg: shop/internal/orders/adapters/outbound
              desc: inbound adapters call use cases; only the composition root knows outbound adapters
        outbound-adapters-do-not-import-inbound:
          files:
            - "**/internal/orders/adapters/outbound/**"
            - "!$test"
          deny:
            - pkg: shop/internal/orders/adapters/inbound
              desc: outbound adapters implement ports and never call inbound adapters
        orders-does-not-import-catalog:
          files:
            - "**/internal/orders/**"
          deny:
            - pkg: shop/internal/catalog
              desc: bounded contexts integrate through events or an explicit API, not imports
        catalog-does-not-import-orders:
          files:
            - "**/internal/catalog/**"
          deny:
            - pkg: shop/internal/orders
              desc: bounded contexts integrate through events or an explicit API, not imports
```

- `list-mode: strict` makes the domain and application rules allow-lists: any new third-party import fails until someone decides it belongs there.
- `"!$test"` exempts tests, which may import fakes from `orderstest`.
- Add one application rule and one pair of context rules per bounded context. Go's own rules do the rest: import cycles do not compile, and `internal/` cannot be imported from outside the module.
