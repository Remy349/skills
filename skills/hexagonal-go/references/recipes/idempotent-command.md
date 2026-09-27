# Recipe: idempotent command with an Idempotency-Key

## Problem

A client posts an order, the connection drops before the response arrives, and the client retries. Without protection the retry creates a second order (or a second charge). `POST` is not idempotent by definition, so the API must make it so.

## Use it when / skip it when

- Use when: a command creates something or has an external effect (orders, payments, emails), and clients or gateways retry.
- Skip when: the operation is naturally idempotent (`PUT` with the full resource, `DELETE`, a state transition guarded by the aggregate such as "cancel a pending order").

## Design

- **The client sends `Idempotency-Key`** (a UUID it generates per logical operation) on the `POST`.
- **A decorator wraps the use case.** `IdempotentPlaceOrder` has the same input and output plus the key; `PlaceOrder` stays unaware of idempotency (Open/Closed).
- **Reserve, execute, complete.** The store atomically reserves `(scope, key)` with a fingerprint of the request. The first request executes and stores the response; a retry with the same key and payload gets the stored response; the same key with a different payload is rejected; a retry while the first is still running gets a conflict.
- **Failures release the key** so the client can retry a command that failed, even if the request context was cancelled (`context.WithoutCancel`).
- **Scope** separates keys per command (`place-order`), so one key cannot collide across endpoints.

## Code

```go
// internal/orders/app/idempotency.go
package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"shop/internal/sharedkernel"
)

var (
	ErrIdempotencyKeyReused = sharedkernel.Invalid("IDEMPOTENCY_KEY_REUSED", "idempotency key was already used with a different request")
	ErrRequestInProgress    = sharedkernel.Conflict("IDEMPOTENCY_IN_PROGRESS", "a request with this idempotency key is still in progress")
)

// IdempotencyRecord is a claimed key. Response is nil while the first request is still running.
type IdempotencyRecord struct {
	Fingerprint string
	Response    []byte
}

type IdempotencyStore interface {
	// Reserve atomically claims the key. It returns nil when the key was claimed now,
	// or the existing record when it was already claimed.
	Reserve(ctx context.Context, scope, key, fingerprint string) (*IdempotencyRecord, error)
	Complete(ctx context.Context, scope, key string, response []byte) error
	// Release forgets a claim whose command failed, so the client can retry.
	Release(ctx context.Context, scope, key string) error
}

// IdempotentPlaceOrder decorates PlaceOrder: a repeated key replays the stored result.
// PlaceOrder itself stays unaware of idempotency.
type IdempotentPlaceOrder struct {
	inner *PlaceOrder
	store IdempotencyStore
}

const placeOrderScope = "place-order"

func NewIdempotentPlaceOrder(inner *PlaceOrder, store IdempotencyStore) *IdempotentPlaceOrder {
	return &IdempotentPlaceOrder{inner: inner, store: store}
}

func (uc *IdempotentPlaceOrder) Execute(ctx context.Context, in PlaceOrderInput, idempotencyKey string) (PlaceOrderOutput, error) {
	if idempotencyKey == "" {
		return uc.inner.Execute(ctx, in)
	}

	fingerprint, err := Fingerprint(in)
	if err != nil {
		return PlaceOrderOutput{}, err
	}
	existing, err := uc.store.Reserve(ctx, placeOrderScope, idempotencyKey, fingerprint)
	if err != nil {
		return PlaceOrderOutput{}, err
	}
	if existing != nil {
		return replay(existing, fingerprint)
	}

	out, err := uc.inner.Execute(ctx, in)
	if err != nil {
		// Release even if the request was cancelled, or the key stays blocked.
		if releaseErr := uc.store.Release(context.WithoutCancel(ctx), placeOrderScope, idempotencyKey); releaseErr != nil {
			return PlaceOrderOutput{}, fmt.Errorf("%w (release idempotency key: %w)", err, releaseErr)
		}
		return PlaceOrderOutput{}, err
	}
	response, err := json.Marshal(out)
	if err != nil {
		return PlaceOrderOutput{}, fmt.Errorf("encode idempotent response: %w", err)
	}
	if err := uc.store.Complete(ctx, placeOrderScope, idempotencyKey, response); err != nil {
		return PlaceOrderOutput{}, err
	}
	return out, nil
}

func replay(existing *IdempotencyRecord, fingerprint string) (PlaceOrderOutput, error) {
	if existing.Fingerprint != fingerprint {
		return PlaceOrderOutput{}, ErrIdempotencyKeyReused
	}
	if existing.Response == nil {
		return PlaceOrderOutput{}, ErrRequestInProgress
	}
	var out PlaceOrderOutput
	if err := json.Unmarshal(existing.Response, &out); err != nil {
		return PlaceOrderOutput{}, fmt.Errorf("decode stored idempotent response: %w", err)
	}
	return out, nil
}

// Fingerprint hashes the use case input, not the raw HTTP body, so key order and
// whitespace do not make two identical requests look different.
func Fingerprint(in PlaceOrderInput) (string, error) {
	raw, err := json.Marshal(in)
	if err != nil {
		return "", fmt.Errorf("fingerprint request: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
```

The fingerprint hashes the use case input, not the raw HTTP body, so formatting differences (key order, whitespace) do not count as a different request. The stored response is opaque bytes for the store; only the decorator knows it is a `PlaceOrderOutput`.

## Tests

A fake store, in a new file of `orderstest`:

```go
// internal/orders/orderstest/idempotency.go
package orderstest

import (
	"context"
	"sync"

	"shop/internal/orders/app"
)

type idempotencyKey struct{ scope, key string }

type InMemoryIdempotencyStore struct {
	mu      sync.Mutex
	Records map[idempotencyKey]app.IdempotencyRecord
}

func NewInMemoryIdempotencyStore() *InMemoryIdempotencyStore {
	return &InMemoryIdempotencyStore{Records: map[idempotencyKey]app.IdempotencyRecord{}}
}

func (s *InMemoryIdempotencyStore) Reserve(_ context.Context, scope, key, fingerprint string) (*app.IdempotencyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.Records[idempotencyKey{scope, key}]; ok {
		return &existing, nil
	}
	s.Records[idempotencyKey{scope, key}] = app.IdempotencyRecord{Fingerprint: fingerprint}
	return nil, nil
}

func (s *InMemoryIdempotencyStore) Complete(_ context.Context, scope, key string, response []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.Records[idempotencyKey{scope, key}]
	record.Response = response
	s.Records[idempotencyKey{scope, key}] = record
	return nil
}

func (s *InMemoryIdempotencyStore) Release(_ context.Context, scope, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.Records, idempotencyKey{scope, key})
	return nil
}
```

```go
// internal/orders/app/idempotency_test.go
package app_test

import (
	"context"
	"errors"
	"testing"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
)

func newIdempotentPlaceOrder() (*app.IdempotentPlaceOrder, *orderstest.FakeUnitOfWork, *orderstest.InMemoryIdempotencyStore) {
	uow := orderstest.NewFakeUnitOfWork()
	store := orderstest.NewInMemoryIdempotencyStore()
	inner := app.NewPlaceOrder(uow, &orderstest.SequentialIDs{}, orderstest.NewFixedClock())
	return app.NewIdempotentPlaceOrder(inner, store), uow, store
}

func TestARetryWithTheSameKeyReplaysTheFirstResult(t *testing.T) {
	placeOrder, uow, _ := newIdempotentPlaceOrder()
	ctx := context.Background()

	first, err := placeOrder.Execute(ctx, orderstest.PlaceOrderInput(), "key-1")
	if err != nil {
		t.Fatal(err)
	}
	retry, err := placeOrder.Execute(ctx, orderstest.PlaceOrderInput(), "key-1")

	if err != nil || retry != first || len(uow.Committed.Rows) != 1 {
		t.Fatalf("retry = %+v, err = %v, orders = %d", retry, err, len(uow.Committed.Rows))
	}
}

func TestTheSameKeyWithADifferentPayloadIsRejected(t *testing.T) {
	placeOrder, _, _ := newIdempotentPlaceOrder()
	ctx := context.Background()
	if _, err := placeOrder.Execute(ctx, orderstest.PlaceOrderInput(), "key-1"); err != nil {
		t.Fatal(err)
	}
	other := orderstest.PlaceOrderInput()
	other.CustomerID = "someone-else"

	_, err := placeOrder.Execute(ctx, other, "key-1")

	if !errors.Is(err, app.ErrIdempotencyKeyReused) {
		t.Fatalf("err = %v, want ErrIdempotencyKeyReused", err)
	}
}

func TestAConcurrentRequestWithTheSameKeyIsAConflict(t *testing.T) {
	placeOrder, _, store := newIdempotentPlaceOrder()
	fingerprint, _ := app.Fingerprint(orderstest.PlaceOrderInput())
	_, _ = store.Reserve(context.Background(), "place-order", "key-1", fingerprint)

	_, err := placeOrder.Execute(context.Background(), orderstest.PlaceOrderInput(), "key-1")

	if !errors.Is(err, app.ErrRequestInProgress) {
		t.Fatalf("err = %v, want ErrRequestInProgress", err)
	}
}

func TestAFailedCommandReleasesTheKey(t *testing.T) {
	placeOrder, _, store := newIdempotentPlaceOrder()
	in := orderstest.PlaceOrderInput()
	in.Lines = nil

	_, err := placeOrder.Execute(context.Background(), in, "key-1")

	if !errors.Is(err, domain.ErrInvalidOrder) || len(store.Records) != 0 {
		t.Fatalf("err = %v, records = %d", err, len(store.Records))
	}
}

func TestWithoutAKeyEveryCallPlacesANewOrder(t *testing.T) {
	placeOrder, uow, _ := newIdempotentPlaceOrder()
	ctx := context.Background()

	for range 2 {
		if _, err := placeOrder.Execute(ctx, orderstest.PlaceOrderInput(), ""); err != nil {
			t.Fatal(err)
		}
	}

	if len(uow.Committed.Rows) != 2 {
		t.Fatalf("orders = %d, want 2", len(uow.Committed.Rows))
	}
}
```

The SQL store's atomicity comes from a primary key, so it is tested against PostgreSQL in `../persistence/pgx.md`, section 7.

## Wiring

- **Outbound.** `postgres.IdempotencyStore` and its table in `../persistence/pgx.md`, section 7. Expire keys after a documented retention window (for example 24 hours) with a scheduled `DELETE`.
- **Composition.** Wrap the plain use case: `app.NewIdempotentPlaceOrder(app.NewPlaceOrder(uow, ids, clock), postgres.NewIdempotencyStore(pool))`, and give the wrapper to the HTTP adapter. The handler's `PlaceOrderUseCase` interface gains the key parameter: `Execute(ctx, in, idempotencyKey string)`.
- **HTTP.** Read the header (`r.Header.Get("Idempotency-Key")`, `c.GetHeader` in Gin, `c.Request().Header.Get` in Echo, `c.Get` in Fiber), reject keys longer than 128 characters with a 400, and pass it through. Replayed responses return the same status and body as the original.
- **Errors.** `ErrIdempotencyKeyReused` is an invalid-family error → 422; `ErrRequestInProgress` is a conflict → 409. Both go through the existing family mapping.
- **Stricter APIs** can require the header on every `POST` and return 400 when it is missing.
