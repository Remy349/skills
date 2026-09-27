# GORM persistence adapter guide

Targets `gorm.io/gorm` 1.31 with `gorm.io/driver/postgres` 1.6. GORM models look like domain types, which is the trap: a struct with `gorm` tags used as the aggregate couples business rules to the schema and to GORM's zero-value semantics. Here GORM models are **persistence models inside the adapter**, mapped explicitly to `domain.OrderSnapshot` (Data Mapper), and the schema is owned by migrations, not by `AutoMigrate`. The domain and use cases are the ones from `../idioms.md`.

## Contents
1. Detection and setup
2. Persistence models and mappers
3. Repository adapter
4. Unit of Work
5. Error translation
6. Optimistic concurrency
7. Outbox, read queries and idempotency
8. Integration tests
9. Migrations
10. Pitfalls

## 1. Detection and setup

`gorm.io/gorm` and `gorm.io/driver/postgres` in `go.mod`, `gorm.Open` in `main`.

```go
// internal/orders/adapters/outbound/postgres/open.go
package postgres

import (
	"database/sql"
	"fmt"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Open wraps an existing *sql.DB. TranslateError turns driver errors into gorm.ErrDuplicatedKey
// and friends; SkipDefaultTransaction stops GORM from opening a transaction per write, because
// transactions belong to the UnitOfWork.
func Open(sqlDB *sql.DB) (*gorm.DB, error) {
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB}), &gorm.Config{
		TranslateError:         true,
		SkipDefaultTransaction: true,
		Logger:                 logger.Discard,
	})
	if err != nil {
		return nil, fmt.Errorf("open gorm: %w", err)
	}
	return db, nil
}
```

In `main`, open the pgx pool as in `pgx.md`, wrap it with `stdlib.OpenDBFromPool(pool)` (`github.com/jackc/pgx/v5/stdlib`), call `postgres.Open`, and pass the `*gorm.DB` to `orders.NewModule`. One pool serves GORM, goose and any hand-written query.

```go
// internal/orders/module.go
// Package orders wires the orders context. It is the only package of the context that
// imports concrete adapters, and it knows nothing about the web framework.
package orders

import (
	"gorm.io/gorm"

	"shop/internal/orders/adapters/outbound/postgres"
	"shop/internal/orders/adapters/outbound/system"
	"shop/internal/orders/app"
)

// Module holds the use cases of the context. Build it once at startup; use cases are safe for concurrent use.
type Module struct {
	PlaceOrder *app.PlaceOrder
}

func NewModule(db *gorm.DB) Module {
	uow := postgres.NewUnitOfWork(db)
	return Module{
		PlaceOrder: app.NewPlaceOrder(uow, system.UUIDGenerator{}, system.Clock{}),
	}
}
```

## 2. Persistence models and mappers

The tables are the goose migrations in `pgx.md`, sections 2 and 7.

```go
// internal/orders/adapters/outbound/postgres/models.go
// Package postgres implements the orders outbound ports with GORM and PostgreSQL.
package postgres

import (
	"fmt"
	"time"

	"shop/internal/orders/domain"
)

// orderRecord and orderLineRecord are persistence models. They never leave this package:
// the domain has no gorm tags, and GORM never sees a domain type.
type orderRecord struct {
	ID         string `gorm:"primaryKey"`
	CustomerID string
	Status     string
	Currency   string
	TotalCents int64
	PlacedAt   time.Time
	PaymentID  *string
	Version    int
	Lines      []orderLineRecord `gorm:"foreignKey:OrderID"`
}

func (orderRecord) TableName() string { return "orders" }

type orderLineRecord struct {
	OrderID        string `gorm:"primaryKey"`
	Position       int    `gorm:"primaryKey"`
	SKU            string `gorm:"column:sku"`
	Quantity       int
	UnitPriceCents int64
}

func (orderLineRecord) TableName() string { return "order_lines" }

func toRecord(order *domain.Order) orderRecord {
	s := order.Snapshot()
	total := order.Total()
	record := orderRecord{
		ID:         string(s.ID),
		CustomerID: s.CustomerID,
		Status:     string(s.Status),
		Currency:   total.Currency(),
		TotalCents: total.Amount(),
		PlacedAt:   s.PlacedAt,
		Version:    1,
	}
	if s.PaymentID != "" {
		record.PaymentID = &s.PaymentID
	}
	for i, line := range s.Lines {
		record.Lines = append(record.Lines, orderLineRecord{
			OrderID: record.ID, Position: i, SKU: line.SKU(), Quantity: line.Quantity(), UnitPriceCents: line.UnitPrice().Amount(),
		})
	}
	return record
}

func toDomain(r orderRecord) (*domain.Order, error) {
	lines := make([]domain.OrderLine, 0, len(r.Lines))
	for _, l := range r.Lines {
		// Stored rows were valid when written; an error here means corrupt data.
		price, err := domain.NewMoney(l.UnitPriceCents, r.Currency)
		if err != nil {
			return nil, fmt.Errorf("order %s has an invalid stored price: %w", r.ID, err)
		}
		line, err := domain.NewOrderLine(l.SKU, l.Quantity, price)
		if err != nil {
			return nil, fmt.Errorf("order %s has an invalid stored line: %w", r.ID, err)
		}
		lines = append(lines, line)
	}
	s := domain.OrderSnapshot{
		ID:         domain.OrderID(r.ID),
		CustomerID: r.CustomerID,
		Lines:      lines,
		Status:     domain.Status(r.Status),
		PlacedAt:   r.PlacedAt.UTC(),
		Version:    r.Version,
	}
	if r.PaymentID != nil {
		s.PaymentID = *r.PaymentID
	}
	return domain.RehydrateOrder(s), nil
}
```

## 3. Repository adapter

`db` is the pool-wide `*gorm.DB` or the transaction handle; `WithContext` passes the request context to every query.

```go
// internal/orders/adapters/outbound/postgres/order_repository.go
package postgres

import (
	"context"
	"errors"
	"fmt"

	"gorm.io/gorm"

	"shop/internal/orders/domain"
)

// OrderRepository implements app.OrderRepository. db is the pool-wide *gorm.DB or a transaction.
type OrderRepository struct {
	db *gorm.DB
}

func NewOrderRepository(db *gorm.DB) *OrderRepository {
	return &OrderRepository{db: db}
}

func (r *OrderRepository) Get(ctx context.Context, id domain.OrderID) (*domain.Order, error) {
	var record orderRecord
	err := r.db.WithContext(ctx).
		Preload("Lines", func(db *gorm.DB) *gorm.DB { return db.Order("position") }).
		First(&record, "id = ?", string(id)).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("%w: %s", domain.ErrOrderNotFound, id)
	}
	if err != nil {
		return nil, fmt.Errorf("get order %s: %w", id, err)
	}
	return toDomain(record)
}

// Add inserts the order and its lines (GORM creates the association in the same statement batch).
func (r *OrderRepository) Add(ctx context.Context, order *domain.Order) error {
	record := toRecord(order)
	err := r.db.WithContext(ctx).Create(&record).Error
	if errors.Is(err, gorm.ErrDuplicatedKey) { // needs gorm.Config{TranslateError: true}
		return fmt.Errorf("%w: %s", domain.ErrDuplicateOrder, order.ID())
	}
	if err != nil {
		return fmt.Errorf("insert order %s: %w", order.ID(), err)
	}
	return nil
}

// Update writes the mutable columns with a version check. A map, not a struct: Updates with a
// struct skips zero values, so clearing payment_id would silently do nothing.
func (r *OrderRepository) Update(ctx context.Context, order *domain.Order) error {
	s := order.Snapshot()
	var paymentID *string
	if s.PaymentID != "" {
		paymentID = &s.PaymentID
	}
	result := r.db.WithContext(ctx).Model(&orderRecord{}).
		Where("id = ? AND version = ?", string(s.ID), s.Version).
		Updates(map[string]any{
			"status":     string(s.Status),
			"payment_id": paymentID,
			"version":    gorm.Expr("version + 1"),
		})
	if result.Error != nil {
		return fmt.Errorf("update order %s: %w", s.ID, result.Error)
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("%w: %s (version %d)", domain.ErrStaleOrder, s.ID, s.Version)
	}
	return nil
}
```

## 4. Unit of Work

```go
// internal/orders/adapters/outbound/postgres/unit_of_work.go
package postgres

import (
	"context"

	"gorm.io/gorm"

	"shop/internal/orders/app"
)

// UnitOfWork implements app.UnitOfWork with db.Transaction, which commits when fn returns nil
// and rolls back on an error or a panic.
type UnitOfWork struct {
	db *gorm.DB
}

func NewUnitOfWork(db *gorm.DB) *UnitOfWork {
	return &UnitOfWork{db: db}
}

func (u *UnitOfWork) Do(ctx context.Context, fn func(tx app.Tx) error) error {
	return u.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(txRepositories{tx: tx})
	})
}

type txRepositories struct {
	tx *gorm.DB
}

func (t txRepositories) Orders() app.OrderRepository { return NewOrderRepository(t.tx) }
```

With `SkipDefaultTransaction: true`, GORM does not wrap single writes in their own transaction; the unit of work decides transaction boundaries, as the use case expects.

## 5. Error translation

| Technology error | Translated to |
|---|---|
| `gorm.ErrRecordNotFound` from `First`/`Take` | `domain.ErrOrderNotFound` |
| `gorm.ErrDuplicatedKey` (requires `TranslateError: true`) | `domain.ErrDuplicateOrder` |
| `RowsAffected == 0` on a versioned update | `domain.ErrStaleOrder` |
| Anything else | wrapped with context, a 500 at the edge |

`Find` never returns `ErrRecordNotFound`: use `First` or `Take` for a lookup by id.

## 6. Optimistic concurrency

`Update` uses `Where("id = ? AND version = ?")` with `Updates(map[string]any{..., "version": gorm.Expr("version + 1")})` and checks `RowsAffected`. GORM's optimistic lock plugin (`gorm.io/plugin/optimisticlock`) does the same with a tag, but the explicit version keeps the rule visible and the model free of plugin types.

## 7. Outbox, read queries and idempotency

The tables are in `pgx.md`, section 7.

```go
// internal/orders/adapters/outbound/postgres/outbox.go
package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"shop/internal/orders/domain"
	"shop/internal/orders/integrationevents"
)

type outboxRecord struct {
	ID          string `gorm:"primaryKey"`
	EventType   string
	Payload     []byte    `gorm:"type:jsonb"`
	OccurredAt  time.Time `gorm:"default:now()"`
	PublishedAt *time.Time
}

func (outboxRecord) TableName() string { return "outbox" }

// Outbox writes integration events in the caller's transaction.
type Outbox struct {
	db *gorm.DB
}

func NewOutbox(db *gorm.DB) *Outbox {
	return &Outbox{db: db}
}

func (o *Outbox) Add(ctx context.Context, events []domain.Event) error {
	if len(events) == 0 {
		return nil
	}
	records := make([]outboxRecord, 0, len(events))
	for _, event := range events {
		msg, err := integrationevents.FromDomain(event)
		if err != nil {
			return err
		}
		records = append(records, outboxRecord{ID: uuid.Must(uuid.NewV7()).String(), EventType: msg.Type, Payload: msg.Payload})
	}
	if err := o.db.WithContext(ctx).Create(&records).Error; err != nil {
		return fmt.Errorf("insert outbox: %w", err)
	}
	return nil
}
```

The unit of work exposes the outbox (this replaces the version in section 4):

```go
// internal/orders/adapters/outbound/postgres/unit_of_work.go
package postgres

import (
	"context"

	"gorm.io/gorm"

	"shop/internal/orders/app"
)

// UnitOfWork implements app.UnitOfWork with db.Transaction, which commits when fn returns nil
// and rolls back on an error or a panic.
type UnitOfWork struct {
	db *gorm.DB
}

func NewUnitOfWork(db *gorm.DB) *UnitOfWork {
	return &UnitOfWork{db: db}
}

func (u *UnitOfWork) Do(ctx context.Context, fn func(tx app.Tx) error) error {
	return u.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(txRepositories{tx: tx})
	})
}

type txRepositories struct {
	tx *gorm.DB
}

func (t txRepositories) Orders() app.OrderRepository { return NewOrderRepository(t.tx) }
func (t txRepositories) Outbox() app.Outbox          { return NewOutbox(t.tx) }
```

```go
// internal/orders/adapters/outbound/postgres/relay.go
package postgres

import (
	"context"
	"fmt"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Publisher sends one message to the broker. MessageID lets consumers deduplicate.
type Publisher interface {
	Publish(ctx context.Context, messageID, eventType string, payload []byte) error
}

// Relay publishes pending outbox rows, at least once. SKIP LOCKED lets several relays share the table.
type Relay struct {
	db        *gorm.DB
	publisher Publisher
	batchSize int
}

func NewRelay(db *gorm.DB, publisher Publisher, batchSize int) *Relay {
	return &Relay{db: db, publisher: publisher, batchSize: batchSize}
}

func (r *Relay) PublishPending(ctx context.Context) (int, error) {
	published := 0
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var batch []outboxRecord
		err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("published_at IS NULL").
			Order("occurred_at, id").
			Limit(r.batchSize).
			Find(&batch).Error
		if err != nil {
			return fmt.Errorf("lock pending outbox rows: %w", err)
		}
		for _, msg := range batch {
			if err := r.publisher.Publish(ctx, msg.ID, msg.EventType, msg.Payload); err != nil {
				return fmt.Errorf("publish %s: %w", msg.ID, err) // rolls back: the batch is retried
			}
			err := tx.Model(&outboxRecord{}).Where("id = ?", msg.ID).Update("published_at", gorm.Expr("now()")).Error
			if err != nil {
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

The read model scans straight into the application DTO with `Table(...).Select(...)`. No model, no preloading:

```go
// internal/orders/adapters/outbound/postgres/order_queries.go
package postgres

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"shop/internal/orders/app"
)

// OrderQueries implements the app.OrderQueries read port. It scans straight into the read
// model: no aggregate, no association preloading.
type OrderQueries struct {
	db *gorm.DB
}

func NewOrderQueries(db *gorm.DB) *OrderQueries {
	return &OrderQueries{db: db}
}

func (q *OrderQueries) ListForCustomer(ctx context.Context, customerID string, after *app.Position, limit int) ([]app.OrderSummary, error) {
	query := q.db.WithContext(ctx).Table("orders").
		Select("id AS order_id, status, total_cents, currency, placed_at").
		Where("customer_id = ?", customerID)
	if after != nil {
		query = query.Where("(placed_at, id) < (?, ?)", after.PlacedAt, after.OrderID)
	}
	var summaries []app.OrderSummary
	if err := query.Order("placed_at DESC, id DESC").Limit(limit).Scan(&summaries).Error; err != nil {
		return nil, fmt.Errorf("list orders of %s: %w", customerID, err)
	}
	for i := range summaries {
		summaries[i].PlacedAt = summaries[i].PlacedAt.UTC()
	}
	return summaries, nil
}
```

```go
// internal/orders/adapters/outbound/postgres/idempotency_store.go
package postgres

import (
	"context"
	"errors"
	"fmt"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"shop/internal/orders/app"
)

type idempotencyRecord struct {
	Scope       string `gorm:"primaryKey"`
	Key         string `gorm:"primaryKey"`
	Fingerprint string
	Response    []byte `gorm:"type:jsonb"`
}

func (idempotencyRecord) TableName() string { return "idempotency_keys" }

// IdempotencyStore implements app.IdempotencyStore. The primary key makes Reserve atomic.
type IdempotencyStore struct {
	db *gorm.DB
}

func NewIdempotencyStore(db *gorm.DB) *IdempotencyStore {
	return &IdempotencyStore{db: db}
}

func (s *IdempotencyStore) Reserve(ctx context.Context, scope, key, fingerprint string) (*app.IdempotencyRecord, error) {
	db := s.db.WithContext(ctx)
	for range 3 { // a concurrent Release can delete the row between the insert and the select
		result := db.Clauses(clause.OnConflict{DoNothing: true}).
			Create(&idempotencyRecord{Scope: scope, Key: key, Fingerprint: fingerprint})
		if result.Error != nil {
			return nil, fmt.Errorf("reserve idempotency key: %w", result.Error)
		}
		if result.RowsAffected == 1 {
			return nil, nil
		}
		var existing idempotencyRecord
		err := db.Where("scope = ? AND key = ?", scope, key).Take(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read idempotency key: %w", err)
		}
		return &app.IdempotencyRecord{Fingerprint: existing.Fingerprint, Response: existing.Response}, nil
	}
	return nil, app.ErrRequestInProgress
}

func (s *IdempotencyStore) Complete(ctx context.Context, scope, key string, response []byte) error {
	err := s.db.WithContext(ctx).Model(&idempotencyRecord{}).
		Where("scope = ? AND key = ?", scope, key).Update("response", response).Error
	if err != nil {
		return fmt.Errorf("complete idempotency key: %w", err)
	}
	return nil
}

func (s *IdempotencyStore) Release(ctx context.Context, scope, key string) error {
	err := s.db.WithContext(ctx).Where("scope = ? AND key = ?", scope, key).Delete(&idempotencyRecord{}).Error
	if err != nil {
		return fmt.Errorf("release idempotency key: %w", err)
	}
	return nil
}
```

## 8. Integration tests

The `pgtest` helper is in `../testing.md`, section 6. `TestMain` builds the `*gorm.DB` on the container's pool:

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
	"github.com/jackc/pgx/v5/stdlib"
	"gorm.io/gorm"

	"shop/internal/orders/adapters/outbound/postgres"
	"shop/internal/platform/pgtest"
)

var (
	sharedPool *pgxpool.Pool
	sharedDB   *gorm.DB
)

func TestMain(m *testing.M) {
	pool, stop, err := pgtest.Start(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	sharedPool = pool
	sharedDB, err = postgres.Open(stdlib.OpenDBFromPool(pool))
	if err != nil {
		log.Fatal(err)
	}
	code := m.Run()
	stop()
	os.Exit(code)
}

// cleanDB returns the shared *gorm.DB after emptying every table.
func cleanDB(t *testing.T) *gorm.DB {
	pgtest.Reset(t, sharedPool)
	return sharedDB
}
```

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
		return postgres.NewOrderRepository(cleanDB(t))
	})
}

func TestUnitOfWorkCommitsWhenFnSucceeds(t *testing.T) {
	db := cleanDB(t)
	placeOrder := app.NewPlaceOrder(postgres.NewUnitOfWork(db), &orderstest.SequentialIDs{}, orderstest.NewFixedClock())

	out, err := placeOrder.Execute(context.Background(), orderstest.PlaceOrderInput())
	if err != nil {
		t.Fatal(err)
	}

	stored, err := postgres.NewOrderRepository(db).Get(context.Background(), domain.OrderID(out.OrderID))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Total().Amount() != 3000 || stored.PlacedAt() != orderstest.Now {
		t.Fatalf("stored = %+v", stored.Snapshot())
	}
}

func TestUnitOfWorkRollsBackWhenFnFails(t *testing.T) {
	db := cleanDB(t)
	failure := errors.New("boom")

	err := postgres.NewUnitOfWork(db).Do(context.Background(), func(tx app.Tx) error {
		if err := tx.Orders().Add(context.Background(), orderstest.Order(t, "order-1")); err != nil {
			return err
		}
		return failure
	})

	if !errors.Is(err, failure) {
		t.Fatalf("err = %v, want the fn error", err)
	}
	_, err = postgres.NewOrderRepository(db).Get(context.Background(), "order-1")
	if !errors.Is(err, domain.ErrOrderNotFound) {
		t.Fatalf("order survived the rollback: err = %v", err)
	}
}
```

The section 7 tests of `pgx.md` for the outbox, the read model and the idempotency store apply with `cleanDB(t)` and `sharedDB` in place of `cleanPool(t)` and `sharedPool`.

## 9. Migrations

Use goose, as in `pgx.md`, section 9. `AutoMigrate` cannot rename or drop columns, has no down path and no history, and makes the schema depend on struct tags; keep it for throwaway prototypes only.

## 10. Pitfalls

- **GORM models as domain entities.** Tags, hooks and zero-value rules end up deciding business behavior. Map in the adapter.
- **`Updates` with a struct skips zero values**: `status: ""`, `quantity: 0` or a `nil` pointer are silently not written. Use a map or `Select("*")` for updates.
- **`Save` is not an update with a guard.** It inserts when the primary key is zero; otherwise it updates every column and, if no row matched, falls back to an upsert. It never detects a stale version and can resurrect a deleted row. Use the versioned `Updates` of section 6.
- **Hooks (`BeforeSave`, `AfterCreate`) for business rules**: rules move out of the domain into persistence callbacks. Keep hooks for technical concerns, if any.
- **Implicit association writes**: `Create` and `Save` also write associations. Be explicit with `Omit(clause.Associations)` when you do not want that.
- **Forgetting `WithContext(ctx)`**: the query ignores cancellation and deadlines.
- **N+1 queries** from lazy patterns in loops: `Preload` what the aggregate needs, and use a read model for lists.
