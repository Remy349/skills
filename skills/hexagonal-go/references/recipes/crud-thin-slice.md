# Recipe: CRUD thin slice

## Problem

A supporting subdomain (product catalog, reference data, settings) needs create/read endpoints. There are no business rules beyond input shape and uniqueness. Aggregates, domain events and a unit of work would add files without removing any pain.

## Use it when / skip it when

- Use when: the feature is data in, data out; the only rules are "exists" and "is unique"; one table backs it.
- Skip when: state transitions appear ("a product can only be discontinued if..."), several rows must change atomically, or other contexts must react to changes. Move that feature to the full slice of `../idioms.md`.

## Design

- **One package** holds the record, the port and the use cases: `internal/catalog`. No `domain/` and `app/` split; Go's flat packages fit a thin slice well.
- **The port still exists.** It keeps SQL out of the use cases, lets tests run without a database, and costs one small interface.
- **Errors reuse the shared-kernel families**, so the HTTP adapter maps them without changes.
- **No check-then-insert.** Uniqueness is the database's job: the adapter translates the unique violation, which also covers two concurrent creates of the same SKU.

## Code

```go
// internal/catalog/products.go
// Package catalog is a supporting subdomain with no business rules beyond input shape:
// one package holds the record, the port and the use cases. There is no domain layer,
// no aggregate and no unit of work, but the port still keeps SQL out of the use cases.
package catalog

import (
	"context"

	"shop/internal/sharedkernel"
)

var (
	ErrProductNotFound  = sharedkernel.NotFound("PRODUCT_NOT_FOUND", "product not found")
	ErrDuplicateProduct = sharedkernel.Conflict("PRODUCT_DUPLICATE", "product already exists")
)

type Product struct {
	SKU        string
	Name       string
	PriceCents int64
	Currency   string
}

type Products interface {
	// Get returns ErrProductNotFound when no product has the sku.
	Get(ctx context.Context, sku string) (Product, error)
	// Add returns ErrDuplicateProduct when the sku exists.
	Add(ctx context.Context, product Product) error
}

type CreateProduct struct {
	products Products
}

func NewCreateProduct(products Products) *CreateProduct {
	return &CreateProduct{products: products}
}

func (uc *CreateProduct) Execute(ctx context.Context, product Product) (Product, error) {
	if err := uc.products.Add(ctx, product); err != nil {
		return Product{}, err
	}
	return product, nil
}

type GetProduct struct {
	products Products
}

func NewGetProduct(products Products) *GetProduct {
	return &GetProduct{products: products}
}

func (uc *GetProduct) Execute(ctx context.Context, sku string) (Product, error) {
	return uc.products.Get(ctx, sku)
}
```

## Tests

The fake lives in the test file because only these tests use it; move it to a `catalogtest` package when a second package needs it.

```go
// internal/catalog/products_test.go
package catalog_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"shop/internal/catalog"
)

type inMemoryProducts map[string]catalog.Product

func (m inMemoryProducts) Get(_ context.Context, sku string) (catalog.Product, error) {
	product, ok := m[sku]
	if !ok {
		return catalog.Product{}, fmt.Errorf("%w: %s", catalog.ErrProductNotFound, sku)
	}
	return product, nil
}

func (m inMemoryProducts) Add(_ context.Context, product catalog.Product) error {
	if _, ok := m[product.SKU]; ok {
		return fmt.Errorf("%w: %s", catalog.ErrDuplicateProduct, product.SKU)
	}
	m[product.SKU] = product
	return nil
}

var lamp = catalog.Product{SKU: "LAMP-1", Name: "Desk lamp", PriceCents: 3990, Currency: "USD"}

func TestCreatedProductCanBeReadBack(t *testing.T) {
	products := inMemoryProducts{}
	ctx := context.Background()

	if _, err := catalog.NewCreateProduct(products).Execute(ctx, lamp); err != nil {
		t.Fatal(err)
	}

	got, err := catalog.NewGetProduct(products).Execute(ctx, "LAMP-1")
	if err != nil || got != lamp {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestDuplicateSKUIsAConflict(t *testing.T) {
	products := inMemoryProducts{"LAMP-1": lamp}

	_, err := catalog.NewCreateProduct(products).Execute(context.Background(), lamp)

	if !errors.Is(err, catalog.ErrDuplicateProduct) {
		t.Fatalf("err = %v, want ErrDuplicateProduct", err)
	}
}

func TestUnknownSKUIsNotFound(t *testing.T) {
	_, err := catalog.NewGetProduct(inMemoryProducts{}).Execute(context.Background(), "missing")

	if !errors.Is(err, catalog.ErrProductNotFound) {
		t.Fatalf("err = %v, want ErrProductNotFound", err)
	}
}
```

## Adapter

```sql
-- migrations/00002_create_products.sql
-- +goose Up
CREATE TABLE products (
    sku         TEXT PRIMARY KEY,
    name        TEXT   NOT NULL,
    price_cents BIGINT NOT NULL,
    currency    TEXT   NOT NULL
);

-- +goose Down
DROP TABLE products;
```

With no unit of work the adapter runs each call on the pool: one short transaction per statement, fine for a single-row write, wrong for writes that must be atomic together. Scanning straight into `catalog.Product` is acceptable here because the record *is* the model; there is no aggregate to protect.

```go
// internal/catalog/postgres/products.go
// Package postgres implements catalog.Products. With no unit of work, each call is its own
// short transaction: fine for a single-row write, not for writes that must be atomic together.
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/catalog"
)

type Products struct {
	pool *pgxpool.Pool
}

func NewProducts(pool *pgxpool.Pool) *Products {
	return &Products{pool: pool}
}

func (p *Products) Get(ctx context.Context, sku string) (catalog.Product, error) {
	rows, err := p.pool.Query(ctx, `SELECT sku, name, price_cents, currency FROM products WHERE sku = $1`, sku)
	if err != nil {
		return catalog.Product{}, fmt.Errorf("get product %s: %w", sku, err)
	}
	product, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[catalog.Product])
	if errors.Is(err, pgx.ErrNoRows) {
		return catalog.Product{}, fmt.Errorf("%w: %s", catalog.ErrProductNotFound, sku)
	}
	if err != nil {
		return catalog.Product{}, fmt.Errorf("get product %s: %w", sku, err)
	}
	return product, nil
}

func (p *Products) Add(ctx context.Context, product catalog.Product) error {
	_, err := p.pool.Exec(ctx,
		`INSERT INTO products (sku, name, price_cents, currency) VALUES ($1, $2, $3, $4)`,
		product.SKU, product.Name, product.PriceCents, product.Currency)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation, also for concurrent inserts
		return fmt.Errorf("%w: %s", catalog.ErrDuplicateProduct, product.SKU)
	}
	if err != nil {
		return fmt.Errorf("insert product %s: %w", product.SKU, err)
	}
	return nil
}
```

```go
// internal/catalog/postgres/products_test.go
//go:build integration

package postgres_test

import (
	"context"
	"errors"
	"log"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"shop/internal/catalog"
	"shop/internal/catalog/postgres"
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

func TestProductsRoundTripAndDuplicates(t *testing.T) {
	pgtest.Reset(t, sharedPool)
	products := postgres.NewProducts(sharedPool)
	ctx := context.Background()
	lamp := catalog.Product{SKU: "LAMP-1", Name: "Desk lamp", PriceCents: 3990, Currency: "USD"}

	if err := products.Add(ctx, lamp); err != nil {
		t.Fatal(err)
	}
	if got, err := products.Get(ctx, "LAMP-1"); err != nil || got != lamp {
		t.Fatalf("got %+v, %v", got, err)
	}
	if err := products.Add(ctx, lamp); !errors.Is(err, catalog.ErrDuplicateProduct) {
		t.Fatalf("err = %v, want ErrDuplicateProduct", err)
	}
	if _, err := products.Get(ctx, "missing"); !errors.Is(err, catalog.ErrProductNotFound) {
		t.Fatalf("err = %v, want ErrProductNotFound", err)
	}
}
```

## Wiring

- **Composition.** A `catalog.NewModule(pool)` (same shape as `orders.NewModule`) builds `NewCreateProduct(postgres.NewProducts(pool))` and `NewGetProduct(...)`.
- **HTTP.** `POST /products` returns `201` with `Location: /products/{sku}`; `GET /products/{sku}` returns `200`. Request DTOs and validation in the context's `httpapi` package, exactly as in `../frameworks/`.
- **Architecture.** `catalog` never imports `orders`, and vice versa; the `depguard` rules in `../idioms.md`, section 9, enforce it.
