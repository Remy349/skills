# Recipe: domain events and the transactional outbox

## Problem

When an order is placed, other parts of the system must react: send an email, reserve stock, update a projection in another service. Publishing to a broker inside the request either happens before the commit (the event describes something that may roll back) or after it (a crash in between loses the event).

## Use it when / skip it when

- Use when: another bounded context or service must learn about a change reliably; you need an audit trail of business facts.
- Skip when: the side effect is local and can run in the same transaction, or losing an occasional notification is acceptable. Do not add a broker for a single in-process listener.

## Design

1. **The aggregate records domain events** as it changes (`OrderPlaced`, `OrderPaid`, `OrderCancelled`). The base `Order` in `../idioms.md` already does this; `PullEvents()` hands them over once.
2. **The use case writes events to an outbox** through a port of the unit of work, in the same transaction as the aggregate. The commit stores both or neither.
3. **The adapter translates domain events into integration events**: explicit, versioned payloads (the published language). Domain events can change freely; integration events are a contract.
4. **A relay publishes** pending outbox rows to the broker and marks them published. Delivery is at-least-once.
5. **Consumers are idempotent**: they record processed message ids and skip duplicates.

## Code

The outbox joins the unit of work, so it shares its transaction. This replaces `app/unit_of_work.go` from `../idioms.md`:

```go
// internal/orders/app/unit_of_work.go
package app

import (
	"context"

	"shop/internal/orders/domain"
)

// Outbox stores events in the same transaction as the aggregate that recorded them.
type Outbox interface {
	Add(ctx context.Context, events []domain.Event) error
}

// Tx gives access to the repositories of one transaction.
type Tx interface {
	Orders() OrderRepository
	Outbox() Outbox
}

// UnitOfWork runs fn in one transaction. It commits when fn returns nil and
// rolls back when fn returns an error or panics.
type UnitOfWork interface {
	Do(ctx context.Context, fn func(tx Tx) error) error
}
```

Every use case that changes an aggregate adds its events before the unit of work commits. `PlaceOrder` becomes:

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
		if err := tx.Orders().Add(ctx, order); err != nil {
			return err
		}
		return tx.Outbox().Add(ctx, order.PullEvents()) // committed with the order, or not at all
	})
	if err != nil {
		return PlaceOrderOutput{}, err
	}

	total := order.Total()
	return PlaceOrderOutput{OrderID: string(order.ID()), TotalCents: total.Amount(), Currency: total.Currency()}, nil
}
```

Add the same step to `CancelOrder`, `PayOrder` and any other command: after `tx.Orders().Update(ctx, order)` succeeds, `return tx.Outbox().Add(ctx, order.PullEvents())`.

The published language is its own package next to the domain. Only adapters import it; `depguard` keeps it out of `domain` and `app`:

```go
// internal/orders/integrationevents/events.go
// Package integrationevents is the published language of the orders context: explicit,
// versioned payloads that other contexts consume. Domain events can change freely;
// these are a contract. Only adapters import this package.
package integrationevents

import (
	"encoding/json"
	"fmt"
	"time"

	"shop/internal/orders/domain"
)

type Message struct {
	Type    string
	Payload []byte
}

type orderPlacedV1 struct {
	OrderID    string    `json:"orderId"`
	CustomerID string    `json:"customerId"`
	TotalCents int64     `json:"totalCents"`
	Currency   string    `json:"currency"`
	OccurredAt time.Time `json:"occurredAt"`
}

type orderPaidV1 struct {
	OrderID    string    `json:"orderId"`
	PaymentID  string    `json:"paymentId"`
	OccurredAt time.Time `json:"occurredAt"`
}

type orderCancelledV1 struct {
	OrderID    string    `json:"orderId"`
	Reason     string    `json:"reason"`
	OccurredAt time.Time `json:"occurredAt"`
}

// FromDomain translates a domain event. An event without a translation is a programming error.
func FromDomain(event domain.Event) (Message, error) {
	var (
		eventType string
		payload   any
	)
	switch e := event.(type) {
	case domain.OrderPlaced:
		eventType = "orders.order_placed.v1"
		payload = orderPlacedV1{
			OrderID: string(e.OrderID), CustomerID: e.CustomerID,
			TotalCents: e.Total.Amount(), Currency: e.Total.Currency(), OccurredAt: e.OccurredAt,
		}
	case domain.OrderPaid:
		eventType = "orders.order_paid.v1"
		payload = orderPaidV1{OrderID: string(e.OrderID), PaymentID: e.PaymentID, OccurredAt: e.OccurredAt}
	case domain.OrderCancelled:
		eventType = "orders.order_cancelled.v1"
		payload = orderCancelledV1{OrderID: string(e.OrderID), Reason: e.Reason, OccurredAt: e.OccurredAt}
	default:
		return Message{}, fmt.Errorf("no integration event for %s", event.EventName())
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return Message{}, fmt.Errorf("encode %s: %w", eventType, err)
	}
	return Message{Type: eventType, Payload: raw}, nil
}
```

The PostgreSQL outbox, the unit of work that exposes it, and the relay are in `../persistence/pgx.md`, section 7 (and the same section of `sqlc.md` and `gorm.md`).

## Tests

The fake unit of work gains an outbox that, like the real one, keeps only the events of committed transactions. This replaces `orderstest/unit_of_work.go` from `../testing.md`:

```go
// internal/orders/orderstest/unit_of_work.go
package orderstest

import (
	"context"
	"maps"
	"slices"
	"sync"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
)

// InMemoryOutbox keeps the events of committed transactions only, like the real one.
type InMemoryOutbox struct {
	Events []domain.Event
}

func (o *InMemoryOutbox) Add(_ context.Context, events []domain.Event) error {
	o.Events = append(o.Events, events...)
	return nil
}

// FakeUnitOfWork stages writes on a copy and applies them only when fn succeeds,
// like a real transaction. Calls are serialized.
type FakeUnitOfWork struct {
	mu              sync.Mutex
	Committed       *InMemoryOrderRepository
	CommittedOutbox *InMemoryOutbox
	Commits         int
}

func NewFakeUnitOfWork() *FakeUnitOfWork {
	return &FakeUnitOfWork{Committed: NewInMemoryOrderRepository(), CommittedOutbox: &InMemoryOutbox{}}
}

func (u *FakeUnitOfWork) Do(_ context.Context, fn func(tx app.Tx) error) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	tx := fakeTx{
		orders: &InMemoryOrderRepository{Rows: maps.Clone(u.Committed.Rows)},
		outbox: &InMemoryOutbox{},
	}
	if err := fn(tx); err != nil {
		return err // staged changes are dropped
	}
	u.Committed = tx.orders
	u.CommittedOutbox.Events = slices.Concat(u.CommittedOutbox.Events, tx.outbox.Events)
	u.Commits++
	return nil
}

type fakeTx struct {
	orders *InMemoryOrderRepository
	outbox *InMemoryOutbox
}

func (t fakeTx) Orders() app.OrderRepository { return t.orders }
func (t fakeTx) Outbox() app.Outbox          { return t.outbox }
```

```go
// internal/orders/app/place_order_outbox_test.go
package app_test

import (
	"context"
	"testing"

	"shop/internal/orders/orderstest"
)

func TestPlaceOrderStoresOrderPlacedInTheSameTransaction(t *testing.T) {
	placeOrder, uow := newPlaceOrder()

	if _, err := placeOrder.Execute(context.Background(), orderstest.PlaceOrderInput()); err != nil {
		t.Fatal(err)
	}

	events := uow.CommittedOutbox.Events
	if len(events) != 1 || events[0].EventName() != "OrderPlaced" {
		t.Fatalf("outbox = %v", events)
	}
}
```

The translation is a contract, so pin its JSON:

```go
// internal/orders/integrationevents/events_test.go
package integrationevents_test

import (
	"testing"

	"shop/internal/orders/domain"
	"shop/internal/orders/integrationevents"
	"shop/internal/orders/orderstest"
)

func TestOrderPlacedIsPublishedAsAVersionedContract(t *testing.T) {
	order := orderstest.Order(t, "order-1")

	msg, err := integrationevents.FromDomain(order.PullEvents()[0])

	if err != nil {
		t.Fatal(err)
	}
	want := `{"orderId":"order-1","customerId":"customer-1","totalCents":1000,"currency":"USD","occurredAt":"2026-01-15T12:00:00Z"}`
	if msg.Type != "orders.order_placed.v1" || string(msg.Payload) != want {
		t.Fatalf("message = %s %s", msg.Type, msg.Payload)
	}
}

func TestEveryOrderEventHasATranslation(t *testing.T) {
	for _, event := range []domain.Event{domain.OrderPlaced{}, domain.OrderPaid{}, domain.OrderCancelled{}} {
		if _, err := integrationevents.FromDomain(event); err != nil {
			t.Errorf("%s: %v", event.EventName(), err)
		}
	}
}
```

Atomicity and relay behavior need a real database; those tests are in `../persistence/pgx.md`, section 7.

## Wiring

- **Relay process.** Run `Relay.PublishPending` in a loop with a `time.Ticker` in a separate binary (`cmd/relay/main.go`) or as a scheduled job. It is an inbound adapter driven by time, not by HTTP, and it shuts down with the same `signal.NotifyContext` pattern.
- **Publisher.** Implement `postgres.Publisher` for your broker (NATS, Kafka, RabbitMQ, SNS/SQS). Pass `messageID` as the broker message id or a header so consumers can deduplicate.
- **Consumers.** In the consuming context the message handler is an inbound adapter: insert the `messageID` into a `processed_messages` table (primary key) in the same transaction as the handler's changes, and skip the message when the insert conflicts.
- **Retention.** Delete published outbox rows after a retention window with a scheduled job.
