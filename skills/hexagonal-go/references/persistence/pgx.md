# pgx persistence adapter guide

Targets `github.com/jackc/pgx/v5` (5.11) with `pgxpool`, plain SQL and goose (3.28) migrations. pgx is a driver, not an ORM: the adapter writes SQL and maps rows to `domain.OrderSnapshot` itself, which keeps the Data Mapper boundary explicit. The domain and use cases are the ones from `../idioms.md`; nothing here changes them.

## Contents
1. Detection and setup
2. Schema and mapping
3. Repository adapter
4. Unit of Work
5. Error translation
6. Optimistic concurrency
7. Outbox, read queries and idempotency
8. Integration tests
9. Migrations
10. Pitfalls

## 1. Detection and setup

`github.com/jackc/pgx/v5` in `go.mod`, `pgxpool.New` in `main`. With `database/sql` + the pgx stdlib driver or `lib/pq`, the same design applies: replace `pgx.Tx` with `*sql.Tx` and `pgx.ErrNoRows` with `sql.ErrNoRows`. With sqlc read `sqlc.md`; with GORM read `gorm.md`.

Create one `*pgxpool.Pool` in `main`, ping it at startup, close it on shutdown, and pass it to each context's `NewModule` (`../idioms.md`, section 5).

## 2. Schema and mapping

```sql
-- migrations/00001_create_orders.sql
-- +goose Up
CREATE TABLE orders (
    id          TEXT PRIMARY KEY,
    customer_id TEXT        NOT NULL,
    status      TEXT        NOT NULL,
    currency    TEXT        NOT NULL,
    total_cents BIGINT      NOT NULL,
    placed_at   TIMESTAMPTZ NOT NULL,
    payment_id  TEXT,
    version     INTEGER     NOT NULL
);

CREATE TABLE order_lines (
    order_id         TEXT    NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    position         INTEGER NOT NULL,
    sku              TEXT    NOT NULL,
    quantity         INTEGER NOT NULL,
    unit_price_cents BIGINT  NOT NULL,
    PRIMARY KEY (order_id, position)
);

CREATE INDEX orders_customer_placed_idx ON orders (customer_id, placed_at DESC, id DESC);

-- +goose Down
DROP TABLE order_lines;
DROP TABLE orders;
```

`currency` and `total_cents` live on `orders`: lines share one currency by construction, and the read model (section 7) lists totals without joining lines.

The migrations are embedded, so the binary, the tests and CI apply exactly the same files (section 9):

```go
// migrations/migrations.go
// Package migrations embeds the SQL migrations so the binary and the tests apply the same files.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
```

Repositories accept a small interface that both `*pgxpool.Pool` and `pgx.Tx` satisfy, so the same code runs inside a unit of work or on its own:

```go
// internal/orders/adapters/outbound/postgres/db.go
// Package postgres implements the orders outbound ports with pgx and PostgreSQL.
package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DBTX is satisfied by *pgxpool.Pool and pgx.Tx, so a repository runs inside or outside a transaction.
type DBTX interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

const uniqueViolation = "23505"

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == uniqueViolation
}
```

## 3. Repository adapter

Rows are mapped to `domain.OrderSnapshot` and back; no pgx type leaves the package.

```go
// internal/orders/adapters/outbound/postgres/order_repository.go
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"shop/internal/orders/domain"
)

// OrderRepository implements app.OrderRepository. Rows are mapped to and from
// domain.OrderSnapshot here; no SQL type leaves this package.
type OrderRepository struct {
	db DBTX
}

func NewOrderRepository(db DBTX) *OrderRepository {
	return &OrderRepository{db: db}
}

func (r *OrderRepository) Get(ctx context.Context, id domain.OrderID) (*domain.Order, error) {
	var row struct {
		CustomerID string
		Status     string
		Currency   string
		PlacedAt   time.Time
		PaymentID  *string
		Version    int
	}
	err := r.db.QueryRow(ctx,
		`SELECT customer_id, status, currency, placed_at, payment_id, version FROM orders WHERE id = $1`, id,
	).Scan(&row.CustomerID, &row.Status, &row.Currency, &row.PlacedAt, &row.PaymentID, &row.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: %s", domain.ErrOrderNotFound, id)
	}
	if err != nil {
		return nil, fmt.Errorf("get order %s: %w", id, err)
	}
	lines, err := r.lines(ctx, id, row.Currency)
	if err != nil {
		return nil, err
	}
	return domain.RehydrateOrder(domain.OrderSnapshot{
		ID:         id,
		CustomerID: row.CustomerID,
		Lines:      lines,
		Status:     domain.Status(row.Status),
		PlacedAt:   row.PlacedAt.UTC(), // pgx returns local time for timestamptz
		Version:    row.Version,
		PaymentID:  derefOrEmpty(row.PaymentID),
	}), nil
}

func (r *OrderRepository) lines(ctx context.Context, id domain.OrderID, currency string) ([]domain.OrderLine, error) {
	rows, err := r.db.Query(ctx,
		`SELECT sku, quantity, unit_price_cents FROM order_lines WHERE order_id = $1 ORDER BY position`, id)
	if err != nil {
		return nil, fmt.Errorf("get order %s lines: %w", id, err)
	}
	type lineRow struct {
		SKU            string
		Quantity       int
		UnitPriceCents int64
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[lineRow])
	if err != nil {
		return nil, fmt.Errorf("get order %s lines: %w", id, err)
	}
	lines := make([]domain.OrderLine, 0, len(stored))
	for _, l := range stored {
		// Stored rows were valid when written; an error here means corrupt data, not a user mistake.
		price, err := domain.NewMoney(l.UnitPriceCents, currency)
		if err != nil {
			return nil, fmt.Errorf("order %s has an invalid stored price: %w", id, err)
		}
		line, err := domain.NewOrderLine(l.SKU, l.Quantity, price)
		if err != nil {
			return nil, fmt.Errorf("order %s has an invalid stored line: %w", id, err)
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func (r *OrderRepository) Add(ctx context.Context, order *domain.Order) error {
	s := order.Snapshot()
	total := order.Total()
	_, err := r.db.Exec(ctx,
		`INSERT INTO orders (id, customer_id, status, currency, total_cents, placed_at, payment_id, version)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
		s.ID, s.CustomerID, s.Status, total.Currency(), total.Amount(), s.PlacedAt, nullIfEmpty(s.PaymentID))
	if isUniqueViolation(err) {
		return fmt.Errorf("%w: %s", domain.ErrDuplicateOrder, s.ID)
	}
	if err != nil {
		return fmt.Errorf("insert order %s: %w", s.ID, err)
	}
	for i, line := range s.Lines {
		_, err := r.db.Exec(ctx,
			`INSERT INTO order_lines (order_id, position, sku, quantity, unit_price_cents) VALUES ($1, $2, $3, $4, $5)`,
			s.ID, i, line.SKU(), line.Quantity(), line.UnitPrice().Amount())
		if err != nil {
			return fmt.Errorf("insert order %s line %d: %w", s.ID, i, err)
		}
	}
	return nil
}

// Update writes the mutable columns. Lines never change after placement, so they are not rewritten.
func (r *OrderRepository) Update(ctx context.Context, order *domain.Order) error {
	s := order.Snapshot()
	tag, err := r.db.Exec(ctx,
		`UPDATE orders SET status = $2, payment_id = $3, version = version + 1 WHERE id = $1 AND version = $4`,
		s.ID, s.Status, nullIfEmpty(s.PaymentID), s.Version)
	if err != nil {
		return fmt.Errorf("update order %s: %w", s.ID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: %s (version %d)", domain.ErrStaleOrder, s.ID, s.Version)
	}
	return nil
}

func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
```

## 4. Unit of Work

`pgx.BeginFunc` commits when the function returns `nil` and rolls back on an error or a panic. Repositories are built per transaction; they are cheap structs.

```go
// internal/orders/adapters/outbound/postgres/unit_of_work.go
package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/orders/app"
)

// UnitOfWork implements app.UnitOfWork with one pgx transaction per call.
type UnitOfWork struct {
	pool *pgxpool.Pool
}

func NewUnitOfWork(pool *pgxpool.Pool) *UnitOfWork {
	return &UnitOfWork{pool: pool}
}

// Do commits when fn returns nil and rolls back on an error or a panic.
func (u *UnitOfWork) Do(ctx context.Context, fn func(tx app.Tx) error) error {
	return pgx.BeginFunc(ctx, u.pool, func(tx pgx.Tx) error {
		return fn(txRepositories{tx: tx})
	})
}

type txRepositories struct {
	tx pgx.Tx
}

func (t txRepositories) Orders() app.OrderRepository { return NewOrderRepository(t.tx) }
```

Use `pgx.BeginTxFunc` with `pgx.TxOptions{IsoLevel: pgx.Serializable}` for a use case that needs a stricter isolation level, and retry on serialization failures (`40001`) in the adapter.

## 5. Error translation

| Technology error | Translated to |
|---|---|
| `pgx.ErrNoRows` on a lookup by id | `domain.ErrOrderNotFound` |
| `*pgconn.PgError` with code `23505` (unique violation) | `domain.ErrDuplicateOrder` |
| Zero rows affected by a versioned `UPDATE` | `domain.ErrStaleOrder` |
| Anything else | wrapped with context (`fmt.Errorf("insert order %s: %w", id, err)`), a 500 at the edge |

Use `errors.As` for `*pgconn.PgError`: the error may be wrapped. `github.com/jackc/pgerrcode` has named constants for the SQLSTATE codes.

## 6. Optimistic concurrency

`Update` writes `WHERE id = $1 AND version = $4` and bumps `version = version + 1`. Zero affected rows means another transaction changed the order since it was loaded: `domain.ErrStaleOrder`, a 409 at the edge. The aggregate's `Version()` is the version it was loaded with; `recipes/aggregate-state-machine.md` adds the client-side check with `If-Match`.

## 7. Outbox, read queries and idempotency

Tables for the recipes:

```sql
-- migrations/00003_create_outbox.sql
-- +goose Up
CREATE TABLE outbox (
    id           TEXT PRIMARY KEY,
    event_type   TEXT        NOT NULL,
    payload      JSONB       NOT NULL,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX outbox_pending_idx ON outbox (occurred_at, id) WHERE published_at IS NULL;

-- +goose Down
DROP TABLE outbox;
```

```sql
-- migrations/00004_create_idempotency_keys.sql
-- +goose Up
CREATE TABLE idempotency_keys (
    scope       TEXT        NOT NULL,
    key         TEXT        NOT NULL,
    fingerprint TEXT        NOT NULL,
    response    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, key)
);

-- +goose Down
DROP TABLE idempotency_keys;
```

**Outbox** (`../recipes/domain-events-outbox.md`). The adapter translates domain events into integration events and inserts them with the caller's transaction:

```go
// internal/orders/adapters/outbound/postgres/outbox.go
package postgres

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"shop/internal/orders/domain"
	"shop/internal/orders/integrationevents"
)

// Outbox writes integration events in the caller's transaction.
type Outbox struct {
	db DBTX
}

func NewOutbox(db DBTX) *Outbox {
	return &Outbox{db: db}
}

func (o *Outbox) Add(ctx context.Context, events []domain.Event) error {
	for _, event := range events {
		msg, err := integrationevents.FromDomain(event)
		if err != nil {
			return err
		}
		_, err = o.db.Exec(ctx,
			`INSERT INTO outbox (id, event_type, payload) VALUES ($1, $2, $3)`,
			uuid.Must(uuid.NewV7()).String(), msg.Type, msg.Payload)
		if err != nil {
			return fmt.Errorf("insert outbox %s: %w", msg.Type, err)
		}
	}
	return nil
}
```

The unit of work exposes it next to the repository (this replaces the version in section 4):

```go
// internal/orders/adapters/outbound/postgres/unit_of_work.go
package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/orders/app"
)

// UnitOfWork implements app.UnitOfWork with one pgx transaction per call.
type UnitOfWork struct {
	pool *pgxpool.Pool
}

func NewUnitOfWork(pool *pgxpool.Pool) *UnitOfWork {
	return &UnitOfWork{pool: pool}
}

// Do commits when fn returns nil and rolls back on an error or a panic.
func (u *UnitOfWork) Do(ctx context.Context, fn func(tx app.Tx) error) error {
	return pgx.BeginFunc(ctx, u.pool, func(tx pgx.Tx) error {
		return fn(txRepositories{tx: tx})
	})
}

type txRepositories struct {
	tx pgx.Tx
}

func (t txRepositories) Orders() app.OrderRepository { return NewOrderRepository(t.tx) }
func (t txRepositories) Outbox() app.Outbox          { return NewOutbox(t.tx) }
```

The relay is a separate process (a worker `cmd/relay`, a ticker, a scheduled job) that publishes pending rows:

```go
// internal/orders/adapters/outbound/postgres/relay.go
package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Publisher sends one message to the broker. MessageID lets consumers deduplicate.
type Publisher interface {
	Publish(ctx context.Context, messageID, eventType string, payload []byte) error
}

// Relay publishes pending outbox rows. Several relays can run at once: SKIP LOCKED hands each
// row to one of them. Delivery is at-least-once: a crash after Publish and before the commit
// sends the message again, so consumers must be idempotent.
type Relay struct {
	pool      *pgxpool.Pool
	publisher Publisher
	batchSize int
}

func NewRelay(pool *pgxpool.Pool, publisher Publisher, batchSize int) *Relay {
	return &Relay{pool: pool, publisher: publisher, batchSize: batchSize}
}

// PublishPending publishes one batch and reports how many messages it sent.
func (r *Relay) PublishPending(ctx context.Context) (int, error) {
	published := 0
	err := pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT id, event_type, payload FROM outbox
			 WHERE published_at IS NULL
			 ORDER BY occurred_at, id
			 LIMIT $1
			 FOR UPDATE SKIP LOCKED`, r.batchSize)
		if err != nil {
			return fmt.Errorf("select pending outbox rows: %w", err)
		}
		type pending struct {
			ID        string
			EventType string
			Payload   []byte
		}
		batch, err := pgx.CollectRows(rows, pgx.RowToStructByPos[pending])
		if err != nil {
			return fmt.Errorf("read pending outbox rows: %w", err)
		}
		for _, msg := range batch {
			if err := r.publisher.Publish(ctx, msg.ID, msg.EventType, msg.Payload); err != nil {
				return fmt.Errorf("publish %s: %w", msg.ID, err) // rolls back: the batch is retried
			}
			if _, err := tx.Exec(ctx, `UPDATE outbox SET published_at = now() WHERE id = $1`, msg.ID); err != nil {
				return fmt.Errorf("mark %s published: %w", msg.ID, err)
			}
			published++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return published, nil
}
```

**Read model** (`../recipes/read-model-pagination.md`). One keyset query, served by the `orders_customer_placed_idx` index:

```go
// internal/orders/adapters/outbound/postgres/order_queries.go
package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"shop/internal/orders/app"
)

// OrderQueries implements the app.OrderQueries read port with one query and no aggregates.
// It relies on the index orders (customer_id, placed_at DESC, id DESC).
type OrderQueries struct {
	db DBTX
}

func NewOrderQueries(db DBTX) *OrderQueries {
	return &OrderQueries{db: db}
}

func (q *OrderQueries) ListForCustomer(ctx context.Context, customerID string, after *app.Position, limit int) ([]app.OrderSummary, error) {
	var afterPlacedAt *time.Time
	var afterID string
	if after != nil {
		afterPlacedAt, afterID = &after.PlacedAt, after.OrderID
	}
	rows, err := q.db.Query(ctx,
		`SELECT id, status, total_cents, currency, placed_at FROM orders
		 WHERE customer_id = $1
		   AND ($2::timestamptz IS NULL OR (placed_at, id) < ($2, $3))
		 ORDER BY placed_at DESC, id DESC
		 LIMIT $4`,
		customerID, afterPlacedAt, afterID, limit)
	if err != nil {
		return nil, fmt.Errorf("list orders of %s: %w", customerID, err)
	}
	summaries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (app.OrderSummary, error) {
		var s app.OrderSummary
		err := row.Scan(&s.OrderID, &s.Status, &s.TotalCents, &s.Currency, &s.PlacedAt)
		s.PlacedAt = s.PlacedAt.UTC()
		return s, err
	})
	if err != nil {
		return nil, fmt.Errorf("list orders of %s: %w", customerID, err)
	}
	return summaries, nil
}
```

The row comparison `(placed_at, id) < ($2, $3)` is what makes keyset pagination correct across identical timestamps.

**Idempotency store** (`../recipes/idempotent-command.md`). The primary key makes the reservation atomic:

```go
// internal/orders/adapters/outbound/postgres/idempotency_store.go
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"shop/internal/orders/app"
)

// IdempotencyStore implements app.IdempotencyStore. The primary key makes Reserve atomic:
// of two concurrent requests with the same key, exactly one inserts the row.
type IdempotencyStore struct {
	db DBTX
}

func NewIdempotencyStore(db DBTX) *IdempotencyStore {
	return &IdempotencyStore{db: db}
}

func (s *IdempotencyStore) Reserve(ctx context.Context, scope, key, fingerprint string) (*app.IdempotencyRecord, error) {
	for range 3 { // a concurrent Release can delete the row between the insert and the select
		tag, err := s.db.Exec(ctx,
			`INSERT INTO idempotency_keys (scope, key, fingerprint) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			scope, key, fingerprint)
		if err != nil {
			return nil, fmt.Errorf("reserve idempotency key: %w", err)
		}
		if tag.RowsAffected() == 1 {
			return nil, nil
		}
		var record app.IdempotencyRecord
		err = s.db.QueryRow(ctx,
			`SELECT fingerprint, response FROM idempotency_keys WHERE scope = $1 AND key = $2`, scope, key,
		).Scan(&record.Fingerprint, &record.Response)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read idempotency key: %w", err)
		}
		return &record, nil
	}
	return nil, app.ErrRequestInProgress
}

func (s *IdempotencyStore) Complete(ctx context.Context, scope, key string, response []byte) error {
	_, err := s.db.Exec(ctx,
		`UPDATE idempotency_keys SET response = $3 WHERE scope = $1 AND key = $2`, scope, key, response)
	if err != nil {
		return fmt.Errorf("complete idempotency key: %w", err)
	}
	return nil
}

func (s *IdempotencyStore) Release(ctx context.Context, scope, key string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, scope, key)
	if err != nil {
		return fmt.Errorf("release idempotency key: %w", err)
	}
	return nil
}
```

**Tests.** These adapters prove what only a real database can: atomicity with the aggregate, `SKIP LOCKED`, keyset ordering across equal timestamps, and the reservation under the primary key. They use `cleanPool` and `sharedPool` from section 8.

```go
// internal/orders/adapters/outbound/postgres/outbox_test.go
//go:build integration

package postgres_test

import (
	"context"
	"testing"

	"shop/internal/orders/adapters/outbound/postgres"
	"shop/internal/orders/app"
	"shop/internal/orders/orderstest"
)

type recordingPublisher struct {
	published []string
}

func (p *recordingPublisher) Publish(_ context.Context, _, eventType string, _ []byte) error {
	p.published = append(p.published, eventType)
	return nil
}

func placeOrderWithPostgres(t *testing.T) {
	t.Helper()
	uc := app.NewPlaceOrder(postgres.NewUnitOfWork(sharedPool), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())
	if _, err := uc.Execute(context.Background(), orderstest.PlaceOrderInput()); err != nil {
		t.Fatal(err)
	}
}

func TestOrderAndIntegrationEventAreCommittedTogether(t *testing.T) {
	cleanPool(t)

	placeOrderWithPostgres(t)

	var eventType string
	var totalCents int64
	err := sharedPool.QueryRow(context.Background(),
		`SELECT event_type, (payload->>'totalCents')::bigint FROM outbox`).Scan(&eventType, &totalCents)
	if err != nil || eventType != "orders.order_placed.v1" || totalCents != 3000 {
		t.Fatalf("outbox row = %s %d, %v", eventType, totalCents, err)
	}
}

func TestRelayPublishesEachPendingMessageOnce(t *testing.T) {
	cleanPool(t)
	placeOrderWithPostgres(t)
	publisher := &recordingPublisher{}
	relay := postgres.NewRelay(sharedPool, publisher, 100)

	first, err := relay.PublishPending(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := relay.PublishPending(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if first != 1 || second != 0 || len(publisher.published) != 1 || publisher.published[0] != "orders.order_placed.v1" {
		t.Fatalf("first = %d, second = %d, published = %v", first, second, publisher.published)
	}
}
```

```go
// internal/orders/adapters/outbound/postgres/order_queries_test.go
//go:build integration

package postgres_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"shop/internal/orders/adapters/outbound/postgres"
	"shop/internal/orders/app"
	"shop/internal/orders/orderstest"
)

func TestOrderQueriesPageNewestFirstAcrossIdenticalTimestamps(t *testing.T) {
	pool := cleanPool(t)
	ctx := context.Background()
	clock := orderstest.NewFixedClock()
	placeOrder := app.NewPlaceOrder(postgres.NewUnitOfWork(pool), &orderstest.SequentialIDs{}, clock)
	for _, advance := range []time.Duration{0, 0, time.Minute} { // the first two share placed_at: the id breaks the tie
		clock.Advance(advance)
		if _, err := placeOrder.Execute(ctx, orderstest.PlaceOrderInput()); err != nil {
			t.Fatal(err)
		}
	}
	queries := postgres.NewOrderQueries(pool)

	first, err := queries.ListForCustomer(ctx, "customer-1", nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	last := first[len(first)-1]
	rest, err := queries.ListForCustomer(ctx, "customer-1", &app.Position{PlacedAt: last.PlacedAt, OrderID: last.OrderID}, 2)
	if err != nil {
		t.Fatal(err)
	}

	var ids []string
	for _, s := range slices.Concat(first, rest) {
		ids = append(ids, s.OrderID)
	}
	if want := []string{"order-3", "order-2", "order-1"}; !slices.Equal(ids, want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
	if !first[0].PlacedAt.Equal(orderstest.Now.Add(time.Minute)) {
		t.Fatalf("placed_at = %v", first[0].PlacedAt)
	}
}
```

```go
// internal/orders/adapters/outbound/postgres/idempotency_store_test.go
//go:build integration

package postgres_test

import (
	"context"
	"testing"

	"shop/internal/orders/adapters/outbound/postgres"
)

func TestAKeyIsReservedOnceThenReturnsTheStoredResponse(t *testing.T) {
	store := postgres.NewIdempotencyStore(cleanPool(t))
	ctx := context.Background()

	claimed, err := store.Reserve(ctx, "place-order", "k-1", "f")
	if err != nil || claimed != nil {
		t.Fatalf("first reserve = %+v, %v", claimed, err)
	}
	inProgress, _ := store.Reserve(ctx, "place-order", "k-1", "f")
	if err := store.Complete(ctx, "place-order", "k-1", []byte(`{"OrderID":"order-1"}`)); err != nil {
		t.Fatal(err)
	}
	completed, _ := store.Reserve(ctx, "place-order", "k-1", "f")

	if inProgress == nil || inProgress.Response != nil {
		t.Fatalf("in progress = %+v", inProgress)
	}
	if completed == nil || string(completed.Response) != `{"OrderID": "order-1"}` {
		t.Fatalf("completed = %+v", completed)
	}
}

func TestAReleasedKeyCanBeReservedAgain(t *testing.T) {
	store := postgres.NewIdempotencyStore(cleanPool(t))
	ctx := context.Background()
	_, _ = store.Reserve(ctx, "place-order", "k-1", "f")

	if err := store.Release(ctx, "place-order", "k-1"); err != nil {
		t.Fatal(err)
	}

	if again, err := store.Reserve(ctx, "place-order", "k-1", "f"); err != nil || again != nil {
		t.Fatalf("reserve after release = %+v, %v", again, err)
	}
}
```

## 8. Integration tests

`main_test.go` and the `pgtest` helper are in `../testing.md`, section 6. The repository runs the shared contract suite, and the unit of work is tested for commit and rollback:

```go
// internal/orders/adapters/outbound/postgres/order_repository_test.go
//go:build integration

package postgres_test

import (
	"context"
	"errors"
	"testing"

	"shop/internal/orders/adapters/outbound/postgres"
	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
)

func TestOrderRepository(t *testing.T) {
	orderstest.RunOrderRepositoryContract(t, func(t *testing.T) app.OrderRepository {
		return postgres.NewOrderRepository(cleanPool(t))
	})
}

func TestUnitOfWorkCommitsWhenFnSucceeds(t *testing.T) {
	pool := cleanPool(t)
	placeOrder := app.NewPlaceOrder(postgres.NewUnitOfWork(pool), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())

	out, err := placeOrder.Execute(context.Background(), orderstest.PlaceOrderInput())
	if err != nil {
		t.Fatal(err)
	}

	stored, err := postgres.NewOrderRepository(pool).Get(context.Background(), domain.OrderID(out.OrderID))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Total().Amount() != 3000 || stored.PlacedAt() != orderstest.Now {
		t.Fatalf("stored = %+v", stored.Snapshot())
	}
}

func TestUnitOfWorkRollsBackWhenFnFails(t *testing.T) {
	pool := cleanPool(t)
	failure := errors.New("boom")

	err := postgres.NewUnitOfWork(pool).Do(context.Background(), func(tx app.Tx) error {
		if err := tx.Orders().Add(context.Background(), orderstest.Order(t, "order-1")); err != nil {
			return err
		}
		return failure
	})

	if !errors.Is(err, failure) {
		t.Fatalf("err = %v, want the fn error", err)
	}
	_, err = postgres.NewOrderRepository(pool).Get(context.Background(), "order-1")
	if !errors.Is(err, domain.ErrOrderNotFound) {
		t.Fatalf("order survived the rollback: err = %v", err)
	}
}
```

## 9. Migrations

goose SQL migrations live in `migrations/` and are embedded with `migrations.FS` (section 2).

- Apply them from a deploy step or a `cmd/migrate` binary with `goose.NewProvider(goose.DialectPostgres, db, migrations.FS)` and `provider.Up(ctx)`; `stdlib.OpenDBFromPool(pool)` gives goose a `*sql.DB`. The `goose` CLI works on the same directory during development.
- Never change an applied migration; add a new one. Keep migrations backward compatible with the running version for zero-downtime deploys (add a column, deploy, backfill, then constrain).
- The schema is owned by migrations, not by the Go code: there is no "auto migrate" at startup.

## 10. Pitfalls

- **Scanning `timestamptz` gives local time.** Convert with `.UTC()` when mapping, and truncate the clock to microseconds (`system.Clock` in `../idioms.md`) so a reloaded aggregate equals the one in memory.
- **Forgetting `rows.Close` or `rows.Err`.** `pgx.CollectRows` and `pgx.CollectExactlyOneRow` handle both.
- **Using the pool inside a transaction.** Inside `Do`, every query must go through the `pgx.Tx`; a query on the pool runs outside the transaction and can deadlock against it.
- **Remote calls inside `BeginFunc`.** The transaction holds locks while the network waits. See `../recipes/external-api-acl.md`.
- **Building SQL with `fmt.Sprintf` and user input.** Always use placeholders (`$1`).
- **Returning `pgx` types from the adapter**, or letting `pgconn.PgError` reach the HTTP layer.
