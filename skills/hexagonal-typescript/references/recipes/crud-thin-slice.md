# Recipe: CRUD thin slice

## Problem

A supporting subdomain (product catalog, reference data, settings) needs create/read/update/delete endpoints. There are no business rules beyond input shape and uniqueness. Full aggregates, domain events and a unit of work would add files without removing any pain.

## Use it when / skip it when

- Use when: the feature is data in, data out; the only rules are "exists" and "is unique"; one table backs it.
- Skip when: state transitions appear ("a product can only be discontinued if..."), several entities must change atomically, or other contexts need to react to changes. Move to the full slice in `../idioms.md` for that feature only.

## Design

- One module in the application layer holds the record type, the port and the use cases. No `domain/` folder.
- The port still exists: it keeps SQL out of the use cases, lets tests run without a database, and costs one small interface.
- Errors reuse the shared-kernel families (`NotFoundError`, `ConflictError`), so the HTTP error mapping handles them unchanged.
- The price is a decimal string: no arithmetic happens yet, so a `Money` value object would be premature, and a float would be wrong.

## Code

```typescript
// src/catalog/application/products.ts
/**
 * Thin slice: a supporting subdomain with no business rules beyond input shape.
 *
 * No aggregate, no domain events, one small module. The port still keeps SQL out of the use cases,
 * so tests need no database and the storage can change later.
 */
import { ConflictError, NotFoundError } from "../../shared-kernel/errors.js";

export type Product = {
  readonly sku: string;
  readonly name: string;
  /** Decimal string ("39.90") so no float ever touches the price. */
  readonly price: string;
  readonly currency: string;
};

export interface ProductCatalog {
  get(sku: string): Promise<Product | null>;
  /** Rejects with ConflictError when the sku already exists. */
  add(product: Product): Promise<void>;
}

export class CreateProductUseCase {
  constructor(private readonly catalog: ProductCatalog) {}

  async execute(product: Product): Promise<Product> {
    if ((await this.catalog.get(product.sku)) !== null) {
      throw new ConflictError(`product ${product.sku} already exists`);
    }
    await this.catalog.add(product);
    return product;
  }
}

export class GetProductUseCase {
  constructor(private readonly catalog: ProductCatalog) {}

  async execute(sku: string): Promise<Product> {
    const product = await this.catalog.get(sku);
    if (product === null) throw new NotFoundError(`product ${sku} not found`);
    return product;
  }
}
```

Checking `get` before `add` gives a clear error in the common case; the adapter still translates the unique-constraint violation to `ConflictError` for the race where two requests create the same sku at once.

## Tests

```typescript
// test/catalog/products.test.ts
import { describe, expect, it } from "vitest";
import {
  CreateProductUseCase,
  GetProductUseCase,
  type Product,
  type ProductCatalog,
} from "../../src/catalog/application/products.js";
import { ConflictError, NotFoundError } from "../../src/shared-kernel/errors.js";

class InMemoryProductCatalog implements ProductCatalog {
  readonly products = new Map<string, Product>();

  async get(sku: string): Promise<Product | null> {
    return this.products.get(sku) ?? null;
  }

  async add(product: Product): Promise<void> {
    if (this.products.has(product.sku)) throw new ConflictError(`product ${product.sku} already exists`);
    this.products.set(product.sku, product);
  }
}

const LAMP: Product = { sku: "LAMP-1", name: "Desk lamp", price: "39.90", currency: "USD" };

describe("catalog", () => {
  it("reads back a created product", async () => {
    const catalog = new InMemoryProductCatalog();

    await new CreateProductUseCase(catalog).execute(LAMP);

    expect(await new GetProductUseCase(catalog).execute("LAMP-1")).toEqual(LAMP);
  });

  it("rejects a duplicate sku", async () => {
    const catalog = new InMemoryProductCatalog();
    await new CreateProductUseCase(catalog).execute(LAMP);

    await expect(new CreateProductUseCase(catalog).execute(LAMP)).rejects.toThrow(ConflictError);
  });

  it("reports an unknown sku as not found", async () => {
    await expect(new GetProductUseCase(new InMemoryProductCatalog()).execute("missing")).rejects.toThrow(NotFoundError);
  });
});
```

The fake lives in the test file because only these tests use it. Move it to `test/support/fakes.ts` when a second file needs it.

## Wiring

- Outbound: a `PrismaProductCatalog` (or TypeORM/Drizzle equivalent) with `get` and `add`, translating the unique violation to `ConflictError`, following `../persistence/`. With no unit of work, the adapter runs its own single-statement write: acceptable for one row, not for anything that must be atomic with another write.
- Inbound: `POST /products` and `GET /products/:sku` with a Zod schema in the adapter, exactly as in `../frameworks/`.
- Architecture: the `catalog` context never imports `orders`, and vice versa. The `bounded-contexts-are-independent` rule in `../idioms.md` enforces it.
