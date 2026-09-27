# Recipe: aggregate with a state machine and optimistic concurrency

## Problem

An order moves through states (`pending → paid`, `pending → cancelled`) and some transitions must be impossible (cancel a paid order, pay twice). Two clients may act on the same order at the same time, and the loser must not silently overwrite the winner.

## Use it when / skip it when

- Use when: an entity has a lifecycle with rules about which operations are allowed in which state; concurrent edits are possible (several users, retries, background jobs).
- Skip when: the entity is plain data (use `crud-thin-slice.md`) or updates are last-write-wins by design.

## Design

- **The aggregate owns the transitions.** `Order.Pay` and `Order.Cancel` (in `../idioms.md`, section 4) check the current state through `ensureStatus` and return `ErrInvalidTransition`, a conflict, so the HTTP adapter answers 409 without knowing the rule.
- **No setters.** Fields are unexported; code outside the package calls intention-revealing methods.
- **Optimistic concurrency** uses the version the aggregate was loaded with. The repository updates with `WHERE version = $n` and returns `ErrStaleOrder` when no row changes (`../persistence/`, section 6).
- **Client-side precondition.** The client sends the version it saw (`If-Match`); the use case rejects a mismatch before doing any work.

For larger machines, replace the per-method guards with a transition table, so the allowed moves are data you can read and test in one place:

```go
var allowedTransitions = map[Status][]Status{
	StatusPending:   {StatusPaid, StatusCancelled},
	StatusPaid:      nil,
	StatusCancelled: nil,
}

func (o *Order) transitionTo(target Status) error {
	if !slices.Contains(allowedTransitions[o.status], target) {
		return fmt.Errorf("%w: cannot go from %s to %s", ErrInvalidTransition, o.status, target)
	}
	o.status = target
	return nil
}
```

## Code

The use case loads, checks the precondition, asks the aggregate to change, and saves, all in one unit of work. It contains no rule about which states allow cancelling.

```go
// internal/orders/app/cancel_order.go
package app

import (
	"context"
	"fmt"

	"shop/internal/orders/domain"
)

type CancelOrderInput struct {
	OrderID string
	Reason  string
	// ExpectedVersion comes from If-Match; nil skips the client-side check.
	ExpectedVersion *int
}

type CancelOrder struct {
	uow   UnitOfWork
	clock Clock
}

func NewCancelOrder(uow UnitOfWork, clock Clock) *CancelOrder {
	return &CancelOrder{uow: uow, clock: clock}
}

// Execute loads, checks the precondition, asks the aggregate to change and saves.
// Which states allow cancelling is the aggregate's rule, not the use case's.
func (uc *CancelOrder) Execute(ctx context.Context, in CancelOrderInput) error {
	return uc.uow.Do(ctx, func(tx Tx) error {
		order, err := tx.Orders().Get(ctx, domain.OrderID(in.OrderID))
		if err != nil {
			return err
		}
		if in.ExpectedVersion != nil && *in.ExpectedVersion != order.Version() {
			return fmt.Errorf("%w: order %s is at version %d", domain.ErrStaleOrder, in.OrderID, order.Version())
		}
		if err := order.Cancel(in.Reason, uc.clock.Now()); err != nil {
			return err
		}
		return tx.Orders().Update(ctx, order)
	})
}
```

## Tests

The domain rules (pay once, cancel only when pending, events recorded) are covered by the domain tests in `../testing.md`, section 4. The use case is tested with fakes, covering success, not found, stale version and the forbidden transition:

```go
// internal/orders/app/cancel_order_test.go
package app_test

import (
	"context"
	"errors"
	"testing"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
)

// newCancelOrder stores order-1 (version 1) and returns the use case and its unit of work.
func newCancelOrder(t *testing.T) (*app.CancelOrder, *orderstest.FakeUnitOfWork) {
	t.Helper()
	uow := orderstest.NewFakeUnitOfWork()
	if err := uow.Committed.Add(context.Background(), orderstest.Order(t, "order-1")); err != nil {
		t.Fatal(err)
	}
	return app.NewCancelOrder(uow, orderstest.NewFixedClock()), uow
}

func version(v int) *int { return &v }

func TestCancelOrderCancelsAPendingOrder(t *testing.T) {
	cancelOrder, uow := newCancelOrder(t)

	err := cancelOrder.Execute(context.Background(), app.CancelOrderInput{OrderID: "order-1", Reason: "changed my mind", ExpectedVersion: version(1)})

	if err != nil {
		t.Fatal(err)
	}
	stored, _ := uow.Committed.Get(context.Background(), "order-1")
	if stored.Status() != domain.StatusCancelled || stored.Version() != 2 {
		t.Fatalf("stored = %+v", stored.Snapshot())
	}
}

func TestCancelOrderFailures(t *testing.T) {
	tests := []struct {
		name string
		in   app.CancelOrderInput
		want error
	}{
		{"unknown order", app.CancelOrderInput{OrderID: "missing", Reason: "x"}, domain.ErrOrderNotFound},
		{"stale version", app.CancelOrderInput{OrderID: "order-1", Reason: "x", ExpectedVersion: version(7)}, domain.ErrStaleOrder},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cancelOrder, uow := newCancelOrder(t)

			err := cancelOrder.Execute(context.Background(), tt.in)

			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
			stored, _ := uow.Committed.Get(context.Background(), "order-1")
			if stored.Status() != domain.StatusPending {
				t.Fatalf("order changed: %+v", stored.Snapshot())
			}
		})
	}
}

func TestCancelOrderCannotCancelTwice(t *testing.T) {
	cancelOrder, _ := newCancelOrder(t)
	ctx := context.Background()
	if err := cancelOrder.Execute(ctx, app.CancelOrderInput{OrderID: "order-1", Reason: "first"}); err != nil {
		t.Fatal(err)
	}

	err := cancelOrder.Execute(ctx, app.CancelOrderInput{OrderID: "order-1", Reason: "second"})

	if !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("err = %v, want ErrInvalidTransition", err)
	}
}
```

## Wiring

- **HTTP.** `POST /orders/{id}/cancellation` with `{"reason": "..."}` returns `204`. Read the path value (`r.PathValue("id")`, `c.Param("id")` in Gin and Echo, `c.Params("id")` in Fiber). Parse `If-Match` with `strconv.Atoi` after trimming quotes; a malformed header is a 400, an absent one leaves `ExpectedVersion` nil. On reads, return the version as an `ETag` header so clients can send it back.
- **Errors.** `ErrOrderNotFound` → 404, `ErrInvalidTransition` and `ErrStaleOrder` → 409, through the family mapping in `../frameworks/`. No new mapping code.
- **Composition.** Add `CancelOrder: app.NewCancelOrder(uow, system.Clock{})` to `orders.Module`.
