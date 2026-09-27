# Recipe: read model with cursor pagination

## Problem

A screen lists a customer's orders, newest first, possibly thousands of them. Loading aggregates to build a list is wasteful, and `OFFSET` pagination gets slower with every page and skips or repeats rows when new orders arrive between requests.

## Use it when / skip it when

- Use when: an endpoint lists or searches; the data can grow; clients page through it.
- Skip cursor pagination when: the list is small and bounded (an admin table of 50 rows); `page`/`pageSize` is simpler there. Still keep a maximum page size.

## Design

- **Separate read port.** `OrderQueries` returns `OrderSummary` DTOs shaped for the screen. It never loads `Order` aggregates and never goes through the unit of work (a light form of CQRS).
- **Keyset (seek) pagination.** Order by a unique, stable key: `(placed_at DESC, id DESC)`. The next page starts strictly after the last row returned, so inserts do not shift pages.
- **Opaque cursor.** The client receives an encoded position, not raw column values; the format can change without breaking clients. Encoding and decoding are plain application code.
- **One extra row.** Asking the port for `limit + 1` rows tells whether another page exists without a `COUNT(*)`.
- **Bounded input.** The use case clamps the limit to `MaxPageSize`, whatever the adapter validated.

## Code

```go
// internal/orders/app/list_orders.go
package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"shop/internal/sharedkernel"
)

const (
	DefaultPageSize = 20
	MaxPageSize     = 100
)

var ErrInvalidCursor = sharedkernel.Invalid("CURSOR_INVALID", "invalid cursor")

// OrderSummary is a read model: shaped for the screen, not for the aggregate.
type OrderSummary struct {
	OrderID    string
	Status     string
	TotalCents int64
	Currency   string
	PlacedAt   time.Time
}

// Position is the keyset position: the sort key of the last row returned
// (newest first, the id breaks ties).
type Position struct {
	PlacedAt time.Time
	OrderID  string
}

// Encode returns an opaque cursor. Clients must not parse it; the format may change.
func (p Position) Encode() string {
	raw := p.PlacedAt.UTC().Format(time.RFC3339Nano) + "|" + p.OrderID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func DecodePosition(cursor string) (Position, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return Position{}, fmt.Errorf("%w: not base64", ErrInvalidCursor)
	}
	placedAt, orderID, ok := strings.Cut(string(raw), "|")
	if !ok || orderID == "" {
		return Position{}, fmt.Errorf("%w: malformed", ErrInvalidCursor)
	}
	t, err := time.Parse(time.RFC3339Nano, placedAt)
	if err != nil {
		return Position{}, fmt.Errorf("%w: bad timestamp", ErrInvalidCursor)
	}
	return Position{PlacedAt: t, OrderID: orderID}, nil
}

// OrderQueries is a read port. It is implemented with a direct query and never loads aggregates.
type OrderQueries interface {
	// ListForCustomer returns up to limit summaries ordered by (placed_at desc, id desc),
	// strictly after the position when one is given.
	ListForCustomer(ctx context.Context, customerID string, after *Position, limit int) ([]OrderSummary, error)
}

type ListOrdersInput struct {
	CustomerID string
	Limit      int    // 0 means DefaultPageSize
	Cursor     string // empty for the first page
}

type OrderPage struct {
	Items      []OrderSummary
	NextCursor string // empty on the last page
}

type ListOrders struct {
	queries OrderQueries
}

func NewListOrders(queries OrderQueries) *ListOrders {
	return &ListOrders{queries: queries}
}

func (uc *ListOrders) Execute(ctx context.Context, in ListOrdersInput) (OrderPage, error) {
	limit := in.Limit
	if limit == 0 {
		limit = DefaultPageSize
	}
	limit = min(max(limit, 1), MaxPageSize) // bounded whatever the adapter validated

	var after *Position
	if in.Cursor != "" {
		position, err := DecodePosition(in.Cursor)
		if err != nil {
			return OrderPage{}, err
		}
		after = &position
	}

	// One extra row tells whether another page exists, without a COUNT query.
	rows, err := uc.queries.ListForCustomer(ctx, in.CustomerID, after, limit+1)
	if err != nil {
		return OrderPage{}, err
	}
	page := OrderPage{Items: rows[:min(len(rows), limit)]}
	if len(rows) > limit {
		last := page.Items[len(page.Items)-1]
		page.NextCursor = Position{PlacedAt: last.PlacedAt, OrderID: last.OrderID}.Encode()
	}
	return page, nil
}
```

The cursor is opaque, not secret. If a cursor must not be forged (for example it encodes a tenant), sign it with HMAC (`crypto/hmac`) in the application layer and reject invalid signatures.

## Tests

A fake read port with the same ordering rule as the SQL adapter, in a new file of `orderstest`:

```go
// internal/orders/orderstest/queries.go
package orderstest

import (
	"cmp"
	"context"
	"slices"

	"shop/internal/orders/app"
)

// InMemoryOrderQueries serves summaries with the same ordering and keyset rule as the SQL adapter.
type InMemoryOrderQueries struct {
	ByCustomer map[string][]app.OrderSummary
}

func (q InMemoryOrderQueries) ListForCustomer(_ context.Context, customerID string, after *app.Position, limit int) ([]app.OrderSummary, error) {
	newestFirst := func(a, b app.OrderSummary) int {
		return cmp.Or(b.PlacedAt.Compare(a.PlacedAt), cmp.Compare(b.OrderID, a.OrderID))
	}
	rows := slices.SortedFunc(slices.Values(q.ByCustomer[customerID]), newestFirst)
	if after != nil {
		rows = slices.DeleteFunc(rows, func(s app.OrderSummary) bool {
			return newestFirst(s, app.OrderSummary{PlacedAt: after.PlacedAt, OrderID: after.OrderID}) <= 0
		})
	}
	return rows[:min(len(rows), limit)], nil
}
```

```go
// internal/orders/app/list_orders_test.go
package app_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"shop/internal/orders/app"
	"shop/internal/orders/orderstest"
)

func summaries(count int) []app.OrderSummary {
	rows := make([]app.OrderSummary, count)
	for i := range rows {
		rows[i] = app.OrderSummary{
			OrderID:    fmt.Sprintf("order-%d", i),
			Status:     "pending",
			TotalCents: 100,
			Currency:   "USD",
			PlacedAt:   orderstest.Now.Add(time.Duration(i) * time.Minute),
		}
	}
	return rows
}

func TestListOrdersWalksAllPagesNewestFirstWithoutDuplicates(t *testing.T) {
	listOrders := app.NewListOrders(orderstest.InMemoryOrderQueries{ByCustomer: map[string][]app.OrderSummary{"customer-1": summaries(5)}})
	ctx := context.Background()

	var ids []string
	in := app.ListOrdersInput{CustomerID: "customer-1", Limit: 2}
	for pages := 0; ; pages++ {
		page, err := listOrders.Execute(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			ids = append(ids, item.OrderID)
		}
		if page.NextCursor == "" {
			break
		}
		in.Cursor = page.NextCursor
	}

	if want := []string{"order-4", "order-3", "order-2", "order-1", "order-0"}; !slices.Equal(ids, want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
}

func TestListOrdersCapsThePageSize(t *testing.T) {
	listOrders := app.NewListOrders(orderstest.InMemoryOrderQueries{ByCustomer: map[string][]app.OrderSummary{"customer-1": summaries(150)}})

	page, err := listOrders.Execute(context.Background(), app.ListOrdersInput{CustomerID: "customer-1", Limit: 10_000})

	if err != nil || len(page.Items) != app.MaxPageSize {
		t.Fatalf("items = %d, err = %v", len(page.Items), err)
	}
}

func TestListOrdersRejectsAMalformedCursor(t *testing.T) {
	listOrders := app.NewListOrders(orderstest.InMemoryOrderQueries{})

	_, err := listOrders.Execute(context.Background(), app.ListOrdersInput{CustomerID: "customer-1", Cursor: "not-a-cursor"})

	if !errors.Is(err, app.ErrInvalidCursor) {
		t.Fatalf("err = %v, want ErrInvalidCursor", err)
	}
}
```

`DecodePosition` parses untrusted input: a good fuzz target (`../testing.md`, section 8). Correct paging across identical timestamps needs the real database; that test is in `../persistence/pgx.md`, section 7.

## Wiring

- **Outbound.** `postgres.OrderQueries` in `../persistence/pgx.md`, section 7 (also in `sqlc.md` and `gorm.md`), backed by the index `(customer_id, placed_at DESC, id DESC)`.
- **HTTP.** `GET /orders?limit=20&cursor=...` returning `{"items": [...], "nextCursor": "..."}`, with `nextCursor` omitted or `null` on the last page. Validate `limit` at the edge (an integer from 1 to 100; 400 otherwise). `ErrInvalidCursor` is an invalid-family error, so it maps to 422.
- **Security.** Take `customerID` from the authenticated principal, never from the query string, or any user can list anyone's orders.
- **Composition.** `app.NewListOrders(postgres.NewOrderQueries(pool))`. Point it at a read replica when the primary is busy; the port does not change.
