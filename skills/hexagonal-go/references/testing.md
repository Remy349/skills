# Testing a hexagonal Go service

Tooling for this language. The strategy (what to test at each boundary, fakes vs mocks, CI order) is in `testing-strategy.md`; framework test clients are in `frameworks/`.

## Contents
1. Tools
2. Layout and naming
3. Fakes for every port
4. Test data builders
5. Contract suites shared by fakes and real adapters
6. Integration tests with PostgreSQL in a container
7. Outbound HTTP adapters
8. Fuzzing value objects
9. CI commands

## 1. Tools

| Need | Tool |
|---|---|
| Runner, subtests, table tests | `testing` (standard library) |
| HTTP adapter tests | `net/http/httptest`, or the framework's test helper (see `frameworks/`) |
| Real database | `github.com/testcontainers/testcontainers-go/modules/postgres` + goose migrations |
| Outbound HTTP | `httptest.NewServer` with a scripted handler |
| Properties of value objects | native fuzzing (`go test -fuzz`) |
| Data races | `go test -race` |
| Architecture | `golangci-lint` with `depguard` (`idioms.md`, section 9) |

The standard library is enough. `github.com/google/go-cmp` helps to diff large structs; assertion libraries are optional and should not replace table tests. Freeze time with an injected `FixedClock`, never by patching `time.Now`.

## 2. Layout and naming

```
internal/orders/
  domain/order_test.go              # package domain_test: pure rules
  app/place_order_test.go           # package app_test: use cases with fakes
  orderstest/                       # fakes, builders, contract suites (imported only by tests)
  adapters/outbound/postgres/
    main_test.go                    # //go:build integration: one container per package
    order_repository_test.go        # contract suite against PostgreSQL
  adapters/inbound/httpapi/handler_test.go
internal/platform/pgtest/           # container + migrations helper for integration tests
```

- Test through the public API with external test packages (`package app_test`).
- Name tests after behavior: `TestPlaceOrderRejectsAnOrderWithoutLinesAndStoresNothing`. Use table tests with `t.Run` for variations of one behavior.
- Arrange, act, assert separated by blank lines. `t.Helper()` in helpers, `t.Cleanup` for teardown.
- `orderstest` is a normal package so fakes can be shared across packages, like `net/http/httptest`. Only `_test.go` files import it; `depguard` exempts tests.

## 3. Fakes for every port

Fakes are working in-memory implementations. The repository stores snapshots, so tests cannot share state with the store by accident, and bumps the version like the SQL adapters:

```go
// internal/orders/orderstest/repository.go
// Package orderstest provides fakes and builders for tests of the orders context.
// Like net/http/httptest, it is imported only from _test.go files.
package orderstest

import (
	"context"
	"fmt"

	"shop/internal/orders/domain"
)

// InMemoryOrderRepository stores snapshots, so callers never share state with the store,
// and bumps the version on every write, like the SQL adapters.
type InMemoryOrderRepository struct {
	Rows map[domain.OrderID]domain.OrderSnapshot
}

func NewInMemoryOrderRepository() *InMemoryOrderRepository {
	return &InMemoryOrderRepository{Rows: map[domain.OrderID]domain.OrderSnapshot{}}
}

func (r *InMemoryOrderRepository) Get(_ context.Context, id domain.OrderID) (*domain.Order, error) {
	stored, ok := r.Rows[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", domain.ErrOrderNotFound, id)
	}
	return domain.RehydrateOrder(stored), nil
}

func (r *InMemoryOrderRepository) Add(_ context.Context, order *domain.Order) error {
	if _, ok := r.Rows[order.ID()]; ok {
		return fmt.Errorf("%w: %s", domain.ErrDuplicateOrder, order.ID())
	}
	r.store(order)
	return nil
}

func (r *InMemoryOrderRepository) Update(_ context.Context, order *domain.Order) error {
	stored, ok := r.Rows[order.ID()]
	if !ok || stored.Version != order.Version() {
		return fmt.Errorf("%w: %s", domain.ErrStaleOrder, order.ID())
	}
	r.store(order)
	return nil
}

func (r *InMemoryOrderRepository) store(order *domain.Order) {
	snapshot := order.Snapshot() // like a database: state only, no pending events
	snapshot.Version++
	r.Rows[order.ID()] = snapshot
}
```

The unit of work stages writes on a copy and applies them only when the function succeeds, like a real transaction:

```go
// internal/orders/orderstest/unit_of_work.go
package orderstest

import (
	"context"
	"maps"
	"sync"

	"shop/internal/orders/app"
)

// FakeUnitOfWork stages writes on a copy and applies them only when fn succeeds,
// like a real transaction. Calls are serialized.
type FakeUnitOfWork struct {
	mu        sync.Mutex
	Committed *InMemoryOrderRepository
	Commits   int
}

func NewFakeUnitOfWork() *FakeUnitOfWork {
	return &FakeUnitOfWork{Committed: NewInMemoryOrderRepository()}
}

func (u *FakeUnitOfWork) Do(_ context.Context, fn func(tx app.Tx) error) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	staged := &InMemoryOrderRepository{Rows: maps.Clone(u.Committed.Rows)}
	if err := fn(fakeTx{orders: staged}); err != nil {
		return err // staged changes are dropped
	}
	u.Committed = staged
	u.Commits++
	return nil
}

type fakeTx struct {
	orders *InMemoryOrderRepository
}

func (t fakeTx) Orders() app.OrderRepository { return t.orders }
```

```go
// internal/orders/orderstest/system.go
package orderstest

import (
	"fmt"
	"time"
)

// SequentialIDs returns order-1, order-2, ...
type SequentialIDs struct {
	Prefix string
	next   int
}

func (g *SequentialIDs) NewID() string {
	g.next++
	prefix := g.Prefix
	if prefix == "" {
		prefix = "order"
	}
	return fmt.Sprintf("%s-%d", prefix, g.next)
}

// FixedClock returns Current until the test moves it.
type FixedClock struct {
	Current time.Time
}

func NewFixedClock() *FixedClock { return &FixedClock{Current: Now} }

func (c *FixedClock) Now() time.Time { return c.Current }

func (c *FixedClock) Advance(d time.Duration) { c.Current = c.Current.Add(d) }
```

Recipes add fakes for their own ports in new files of the same package (`payments.go`, `queries.go`, `idempotency.go`); `recipes/domain-events-outbox.md` extends the unit of work with an outbox.

Use a hand-written stub for an interaction with no observable outcome, and never mock a type you do not own (`pgx.Tx`, `*http.Client`): wrap it in a port and fake the port.

## 4. Test data builders

Valid defaults in one place; each test passes only what it is about:

```go
// internal/orders/orderstest/builders.go
package orderstest

import (
	"testing"
	"time"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
)

// Now is the fixed instant every test starts from.
var Now = time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)

// Line builds a valid line; tests pass only the values they are about.
func Line(t testing.TB, sku string, quantity int, unitPriceCents int64, currency string) domain.OrderLine {
	t.Helper()
	price, err := domain.NewMoney(unitPriceCents, currency)
	if err != nil {
		t.Fatal(err)
	}
	line, err := domain.NewOrderLine(sku, quantity, price)
	if err != nil {
		t.Fatal(err)
	}
	return line
}

// Order builds a valid pending order placed at Now, with one 10.00 USD line when no lines are given.
func Order(t testing.TB, id string, lines ...domain.OrderLine) *domain.Order {
	t.Helper()
	if len(lines) == 0 {
		lines = []domain.OrderLine{Line(t, "SKU-1", 1, 1000, "USD")}
	}
	order, err := domain.NewOrder(domain.OrderID(id), "customer-1", lines, Now)
	if err != nil {
		t.Fatal(err)
	}
	return order
}

// PlaceOrderInput returns a valid input: 2 x 15.00 USD.
func PlaceOrderInput() app.PlaceOrderInput {
	return app.PlaceOrderInput{
		CustomerID: "customer-1",
		Currency:   "USD",
		Lines:      []app.PlaceOrderLine{{SKU: "SKU-1", Quantity: 2, UnitPriceCents: 1500}},
	}
}
```

Domain tests use them directly:

```go
// internal/orders/domain/order_test.go
package domain_test

import (
	"errors"
	"reflect"
	"testing"

	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
)

func TestMoneyValidation(t *testing.T) {
	tests := []struct {
		name     string
		amount   int64
		currency string
	}{
		{"negative amount", -1, "USD"},
		{"lowercase currency", 100, "usd"},
		{"short currency", 100, "US"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := domain.NewMoney(tt.amount, tt.currency)

			if !errors.Is(err, domain.ErrInvalidMoney) {
				t.Fatalf("err = %v, want ErrInvalidMoney", err)
			}
		})
	}
}

func TestMoneyRefusesToAddDifferentCurrencies(t *testing.T) {
	usd, _ := domain.NewMoney(100, "USD")
	eur, _ := domain.NewMoney(100, "EUR")

	_, err := usd.Add(eur)

	if !errors.Is(err, domain.ErrInvalidMoney) {
		t.Fatalf("err = %v, want ErrInvalidMoney", err)
	}
}

func TestOrderTotalIsTheSumOfLineSubtotals(t *testing.T) {
	order := orderstest.Order(t, "order-1",
		orderstest.Line(t, "SKU-1", 2, 1500, "USD"),
		orderstest.Line(t, "SKU-2", 1, 250, "USD"),
	)

	want, _ := domain.NewMoney(3250, "USD")
	if got := order.Total(); got != want {
		t.Fatalf("total = %v, want %v", got, want)
	}
}

func TestNewOrderRejectsInvalidLines(t *testing.T) {
	tests := []struct {
		name  string
		lines []domain.OrderLine
	}{
		{"no lines", nil},
		{"mixed currencies", []domain.OrderLine{
			orderstest.Line(t, "SKU-1", 1, 100, "USD"),
			orderstest.Line(t, "SKU-2", 1, 100, "EUR"),
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := domain.NewOrder("order-1", "customer-1", tt.lines, orderstest.Now)

			if !errors.Is(err, domain.ErrInvalidOrder) {
				t.Fatalf("err = %v, want ErrInvalidOrder", err)
			}
		})
	}
}

func TestNewOrderIsPendingAndRecordsOrderPlaced(t *testing.T) {
	order := orderstest.Order(t, "order-1")

	if order.Status() != domain.StatusPending {
		t.Fatalf("status = %s, want pending", order.Status())
	}
	events := order.PullEvents()
	if len(events) != 1 || events[0].EventName() != "OrderPlaced" {
		t.Fatalf("events = %v, want [OrderPlaced]", events)
	}
	if again := order.PullEvents(); len(again) != 0 {
		t.Fatalf("events pulled twice: %v", again)
	}
}

func TestPendingOrderCanBePaidOnce(t *testing.T) {
	order := orderstest.Order(t, "order-1")
	order.PullEvents()

	if err := order.Pay("pay-1", orderstest.Now); err != nil {
		t.Fatal(err)
	}

	if order.Status() != domain.StatusPaid {
		t.Fatalf("status = %s, want paid", order.Status())
	}
	want := []domain.Event{domain.OrderPaid{OrderID: "order-1", PaymentID: "pay-1", OccurredAt: orderstest.Now}}
	if got := order.PullEvents(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	if err := order.Pay("pay-2", orderstest.Now); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("second pay: err = %v, want ErrInvalidTransition", err)
	}
}

func TestOnlyPendingOrdersCanBeCancelled(t *testing.T) {
	tests := map[string]func(*domain.Order) error{
		"paid":      func(o *domain.Order) error { return o.Pay("pay-1", orderstest.Now) },
		"cancelled": func(o *domain.Order) error { return o.Cancel("changed my mind", orderstest.Now) },
	}
	for name, first := range tests {
		t.Run(name, func(t *testing.T) {
			order := orderstest.Order(t, "order-1")
			if err := first(order); err != nil {
				t.Fatal(err)
			}

			err := order.Cancel("again", orderstest.Now)

			if !errors.Is(err, domain.ErrInvalidTransition) {
				t.Fatalf("err = %v, want ErrInvalidTransition", err)
			}
		})
	}
}

func TestRehydrateRestoresStateWithoutEvents(t *testing.T) {
	original := orderstest.Order(t, "order-1")

	restored := domain.RehydrateOrder(original.Snapshot())

	if !reflect.DeepEqual(restored.Snapshot(), original.Snapshot()) {
		t.Fatalf("snapshot = %+v, want %+v", restored.Snapshot(), original.Snapshot())
	}
	if events := restored.PullEvents(); len(events) != 0 {
		t.Fatalf("rehydrated order recorded events: %v", events)
	}
}
```

## 5. Contract suites shared by fakes and real adapters

A port's contract is more than its method set: what `Get` returns for an unknown id, whether `Add` rejects duplicates, how stale versions fail. Write it once as a function that takes a factory; every implementation calls it.

```go
// internal/orders/orderstest/contract.go
package orderstest

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
)

// RunOrderRepositoryContract checks the behavior every OrderRepository must share.
// The fake and each real adapter call it with a factory that returns an empty repository.
func RunOrderRepositoryContract(t *testing.T, newRepository func(t *testing.T) app.OrderRepository) {
	ctx := context.Background()

	t.Run("saved order is found by id with the same state", func(t *testing.T) {
		repo := newRepository(t)
		order := Order(t, "order-1", Line(t, "SKU-1", 2, 1000, "USD"), Line(t, "SKU-2", 1, 5, "USD"))

		mustDo(t, repo.Add(ctx, order))
		found, err := repo.Get(ctx, "order-1")

		mustDo(t, err)
		want := order.Snapshot()
		want.Version = 1
		if got := found.Snapshot(); !reflect.DeepEqual(got, want) {
			t.Fatalf("found %+v, want %+v", got, want)
		}
	})

	t.Run("unknown id is not found", func(t *testing.T) {
		_, err := newRepository(t).Get(ctx, "missing")

		if !errors.Is(err, domain.ErrOrderNotFound) {
			t.Fatalf("err = %v, want ErrOrderNotFound", err)
		}
	})

	t.Run("adding the same id twice is a duplicate", func(t *testing.T) {
		repo := newRepository(t)
		mustDo(t, repo.Add(ctx, Order(t, "order-1")))

		err := repo.Add(ctx, Order(t, "order-1"))

		if !errors.Is(err, domain.ErrDuplicateOrder) {
			t.Fatalf("err = %v, want ErrDuplicateOrder", err)
		}
	})

	t.Run("update persists the new state and bumps the version", func(t *testing.T) {
		repo := newRepository(t)
		mustDo(t, repo.Add(ctx, Order(t, "order-1")))
		order, err := repo.Get(ctx, "order-1")
		mustDo(t, err)
		mustDo(t, order.Pay("pay-1", Now))

		mustDo(t, repo.Update(ctx, order))

		updated, err := repo.Get(ctx, "order-1")
		mustDo(t, err)
		if updated.Status() != domain.StatusPaid || updated.PaymentID() != "pay-1" || updated.Version() != 2 {
			t.Fatalf("updated = %+v", updated.Snapshot())
		}
	})

	t.Run("update with a stale version is rejected", func(t *testing.T) {
		repo := newRepository(t)
		mustDo(t, repo.Add(ctx, Order(t, "order-1")))
		first, err := repo.Get(ctx, "order-1")
		mustDo(t, err)
		second, err := repo.Get(ctx, "order-1")
		mustDo(t, err)
		mustDo(t, first.Cancel("first writer", Now))
		mustDo(t, repo.Update(ctx, first))
		mustDo(t, second.Pay("pay-1", Now))

		err = repo.Update(ctx, second)

		if !errors.Is(err, domain.ErrStaleOrder) {
			t.Fatalf("err = %v, want ErrStaleOrder", err)
		}
	})
}

func mustDo(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
```

```go
// internal/orders/orderstest/fakes_test.go
package orderstest_test

import (
	"testing"

	"shop/internal/orders/app"
	"shop/internal/orders/orderstest"
)

func TestInMemoryOrderRepository(t *testing.T) {
	orderstest.RunOrderRepositoryContract(t, func(*testing.T) app.OrderRepository {
		return orderstest.NewInMemoryOrderRepository()
	})
}
```

The PostgreSQL adapters run the same suite in their integration tests (`persistence/`, section 8).

## 6. Integration tests with PostgreSQL in a container

Test SQL adapters against the database you run in production, with the real migrations. One helper starts the container and resets data between tests:

```go
// internal/platform/pgtest/pgtest.go
// Package pgtest runs PostgreSQL in a container for integration tests.
package pgtest

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"shop/migrations"
)

// Start runs PostgreSQL, applies the real migrations and returns a pool.
// Call it once from TestMain; stop terminates the container.
func Start(ctx context.Context) (*pgxpool.Pool, func(), error) {
	container, err := postgres.Run(ctx, "postgres:17-alpine", postgres.BasicWaitStrategies())
	if err != nil {
		return nil, nil, fmt.Errorf("start postgres: %w", err)
	}
	terminate := func() { _ = testcontainers.TerminateContainer(container) }

	url, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		terminate()
		return nil, nil, err
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		terminate()
		return nil, nil, err
	}
	if err := migrate(ctx, pool); err != nil {
		pool.Close()
		terminate()
		return nil, nil, err
	}
	return pool, func() { pool.Close(); terminate() }, nil
}

func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	db := stdlib.OpenDBFromPool(pool)
	defer func() { _ = db.Close() }()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		return fmt.Errorf("load migrations: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

// Reset empties every application table, so each test starts from a clean database.
func Reset(t testing.TB, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx,
		`SELECT quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'goose_db_version'`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		if _, err := pool.Exec(ctx, "TRUNCATE "+table+" CASCADE"); err != nil {
			t.Fatal(err)
		}
	}
}
```

Each adapter package starts one container in `TestMain`, behind a build tag so `go test ./...` stays fast and needs no Docker:

```go
// internal/orders/adapters/outbound/postgres/main_test.go
//go:build integration

package postgres_test

import (
	"context"
	"log"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/platform/pgtest"
)

var sharedPool *pgxpool.Pool

func TestMain(m *testing.M) {
	pool, stop, err := pgtest.Start(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	sharedPool = pool
	code := m.Run()
	stop()
	os.Exit(code)
}

// cleanPool returns the shared pool after emptying every table.
func cleanPool(t *testing.T) *pgxpool.Pool {
	pgtest.Reset(t, sharedPool)
	return sharedPool
}
```

- `//go:build integration` on every file that needs Docker; run them with `go test -tags integration ./...`.
- One container per package, clean tables per test. Truncation is simpler than rollback tricks because use cases commit their own transactions.
- Tests that share the pool must not call `t.Parallel()`; use one database per test (a template database) if the suite grows slow.
- The migrations are embedded (`migrations/migrations.go`, see `persistence/`), so tests and the binary apply exactly the same files.

## 7. Outbound HTTP adapters

`httptest.NewServer` runs the real adapter against a scripted vendor API, with no network:

```go
func TestFailuresAreTranslated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = io.WriteString(w, `{"decline_code":"insufficient_funds"}`)
	}))
	t.Cleanup(server.Close)
	gateway := payments.NewGateway(&http.Client{Timeout: 100 * time.Millisecond}, server.URL, "test-key")

	_, err := gateway.Authorize(context.Background(), "o", usd(t, 1), "o")

	if !errors.Is(err, app.ErrPaymentDeclined) {
		t.Fatalf("err = %v, want ErrPaymentDeclined", err)
	}
}
```

Cover success, each mapped status, timeouts (a handler slower than the client timeout) and an unreachable host (a closed server). The full example is in `recipes/external-api-acl.md`.

## 8. Fuzzing value objects

Native fuzzing checks an invariant for inputs nobody thought of. `go test` runs only the seed corpus, so the test is cheap in CI; run the fuzzer locally or on a schedule.

```go
// internal/orders/domain/money_fuzz_test.go
package domain_test

import (
	"errors"
	"testing"

	"shop/internal/orders/domain"
)

// FuzzNewMoney checks the invariant for any input: either a typed error or valid money.
// go test only runs the seeds; go test -fuzz=FuzzNewMoney explores new inputs.
func FuzzNewMoney(f *testing.F) {
	f.Add(int64(100), "USD")
	f.Add(int64(-1), "usd")
	f.Fuzz(func(t *testing.T, amount int64, currency string) {
		m, err := domain.NewMoney(amount, currency)
		if err != nil {
			if !errors.Is(err, domain.ErrInvalidMoney) {
				t.Fatalf("unexpected error: %v", err)
			}
			return
		}
		if m.Amount() < 0 || len(m.Currency()) != 3 {
			t.Fatalf("invalid money accepted: %+v", m)
		}
	})
}
```

Good targets: value object constructors, parsers of untrusted input (cursors, headers), and mappers that must round-trip.

## 9. CI commands

```bash
test -z "$(gofmt -l .)"                        # fails on unformatted files
go vet ./...
golangci-lint run ./...                        # includes depguard
go test -race ./...                            # domain, use cases, HTTP adapters: seconds
go test -race -tags integration ./...          # adds containers
govulncheck ./...
```
