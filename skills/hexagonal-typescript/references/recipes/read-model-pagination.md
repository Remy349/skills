# Recipe: read model with cursor pagination

## Problem

A screen lists a customer's orders, newest first, possibly thousands of them. Loading aggregates to build a list is wasteful, and `OFFSET` pagination gets slower with every page and skips or repeats rows when new orders arrive between requests.

## Use it when / skip it when

- Use when: an endpoint lists or searches; the data can grow; clients page through it.
- Skip cursor pagination when: the list is small and bounded (an admin table of 50 rows); `page`/`pageSize` is simpler there. Still keep a maximum page size.

## Design

- **Separate read port.** `OrderQueries` returns `OrderSummary` objects shaped for the screen. It never loads `Order` aggregates and never goes through the unit of work (a light form of CQRS).
- **Keyset (seek) pagination.** Order by a unique, stable key: `(placedAt DESC, orderId DESC)`. The next page starts strictly after the last row returned, so inserts do not shift pages.
- **Opaque cursor.** The client receives an encoded position (`base64url`), not raw column values; the format can change without breaking clients. Encoding and decoding are pure application code.
- **One extra row.** Asking the port for `limit + 1` rows tells whether another page exists without a `COUNT(*)`.
- **Bounded input.** The use case clamps `limit` to `MAX_PAGE_SIZE`, whatever the adapter validated.

## Code

```typescript
// src/orders/application/list-orders.use-case.ts
import { DomainError } from "../../shared-kernel/errors.js";

export const MAX_PAGE_SIZE = 100;

export class InvalidCursorError extends DomainError {
  override readonly code = "CURSOR_INVALID";
}

/** Read model: shaped for the screen, not for the aggregate. */
export type OrderSummary = {
  readonly orderId: string;
  readonly status: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly placedAt: Date;
};

/** Keyset position: the sort key of the last row returned (newest first, id breaks ties). */
export type Position = { readonly placedAt: Date; readonly orderId: string };

export const encodeCursor = (position: Position): string =>
  Buffer.from(`${position.placedAt.toISOString()}|${position.orderId}`).toString("base64url");

export const decodeCursor = (cursor: string): Position => {
  const [placedAt = "", orderId = ""] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const date = new Date(placedAt);
  if (Number.isNaN(date.getTime()) || orderId === "") throw new InvalidCursorError("cursor is malformed");
  return { placedAt: date, orderId };
};

/** Read port. Implemented with a direct query; never loads aggregates. */
export interface OrderQueries {
  /** Up to `limit` summaries ordered by (placedAt desc, orderId desc), strictly after `after`. */
  listForCustomer(input: { customerId: string; after: Position | null; limit: number }): Promise<OrderSummary[]>;
}

export type ListOrdersInput = {
  readonly customerId: string;
  readonly limit?: number;
  readonly cursor?: string | undefined;
};
export type OrderPage = { readonly items: readonly OrderSummary[]; readonly nextCursor: string | null };

export class ListOrdersUseCase {
  constructor(private readonly queries: OrderQueries) {}

  async execute(input: ListOrdersInput): Promise<OrderPage> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, MAX_PAGE_SIZE));
    const after = input.cursor ? decodeCursor(input.cursor) : null;
    // Fetch one extra row to know whether another page exists without a COUNT query.
    const rows = await this.queries.listForCustomer({ customerId: input.customerId, after, limit: limit + 1 });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ placedAt: last.placedAt, orderId: last.orderId }) : null;
    return { items, nextCursor };
  }
}
```

`Buffer` is a Node.js global rather than a library import, so the application layer stays framework-free. The cursor is opaque, not secret: if it must not be forged (for example it encodes a tenant), sign it with an HMAC (`node:crypto`) and reject invalid signatures.

## Tests

Fake read port, added to the shared fakes:

```ts
// test/support/fakes.ts  (addition)
import type { OrderQueries, OrderSummary, Position } from "../../src/orders/application/list-orders.use-case.js";

export class InMemoryOrderQueries implements OrderQueries {
  constructor(private readonly byCustomer: Record<string, OrderSummary[]>) {}

  async listForCustomer(input: { customerId: string; after: Position | null; limit: number }): Promise<OrderSummary[]> {
    const key = (s: { placedAt: Date; orderId: string }) => `${s.placedAt.toISOString()}|${s.orderId}`;
    const rows = [...(this.byCustomer[input.customerId] ?? [])].sort((a, b) => key(b).localeCompare(key(a)));
    const after = input.after;
    return rows.filter((row) => after === null || key(row) < key(after)).slice(0, input.limit);
  }
}
```

```typescript
// test/orders/list-orders.use-case.test.ts
import { describe, expect, it } from "vitest";
import {
  InvalidCursorError,
  ListOrdersUseCase,
  type OrderSummary,
} from "../../src/orders/application/list-orders.use-case.js";
import { InMemoryOrderQueries } from "../support/fakes.js";
import { NOW } from "./builders.js";

const summaries = (count: number): OrderSummary[] =>
  Array.from({ length: count }, (_, i) => ({
    orderId: `order-${i}`,
    status: "pending",
    totalCents: 100,
    currency: "USD",
    placedAt: new Date(NOW.getTime() + i * 60_000),
  }));

describe("ListOrdersUseCase", () => {
  it("walks all pages newest first without duplicates", async () => {
    const listOrders = new ListOrdersUseCase(new InMemoryOrderQueries({ "customer-1": summaries(5) }));

    const first = await listOrders.execute({ customerId: "customer-1", limit: 2 });
    const second = await listOrders.execute({
      customerId: "customer-1",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const third = await listOrders.execute({
      customerId: "customer-1",
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });

    const ids = [first, second, third].flatMap((page) => page.items.map((item) => item.orderId));
    expect(ids).toEqual(["order-4", "order-3", "order-2", "order-1", "order-0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("caps the page size", async () => {
    const listOrders = new ListOrdersUseCase(new InMemoryOrderQueries({ "customer-1": summaries(150) }));

    const page = await listOrders.execute({ customerId: "customer-1", limit: 10_000 });

    expect(page.items).toHaveLength(100);
  });

  it("rejects a malformed cursor", async () => {
    const listOrders = new ListOrdersUseCase(new InMemoryOrderQueries({}));

    await expect(listOrders.execute({ customerId: "customer-1", cursor: "not-a-cursor" })).rejects.toThrow(
      InvalidCursorError,
    );
  });
});
```

The SQL adapter must page correctly across identical timestamps, which only a real database proves (`usePrisma()` is in `domain-events-outbox.md`):

```typescript
// test/integration/prisma-read-model.test.ts
import { describe, expect, it } from "vitest";
import { PrismaOrderQueries } from "../../src/orders/adapters/outbound/prisma/order.queries.js";
import { PrismaUnitOfWork } from "../../src/orders/adapters/outbound/prisma/unit-of-work.js";
import { PlaceOrderUseCase } from "../../src/orders/application/place-order.use-case.js";
import { NOW, aPlaceOrderInput } from "../orders/builders.js";
import { FixedClock, SequentialIds } from "../support/fakes.js";
import { usePrisma } from "../support/prisma.js";

const prisma = usePrisma();

describe("PrismaOrderQueries", () => {
  it("pages newest first across identical timestamps", async () => {
    const clock = new FixedClock(NOW);
    const placeOrder = new PlaceOrderUseCase(new PrismaUnitOfWork(prisma()), new SequentialIds(), clock);
    await placeOrder.execute(aPlaceOrderInput());
    await placeOrder.execute(aPlaceOrderInput()); // same placedAt as the first: the id breaks the tie
    clock.advance(60_000);
    await placeOrder.execute(aPlaceOrderInput());
    const queries = new PrismaOrderQueries(prisma());

    const first = await queries.listForCustomer({ customerId: "customer-1", after: null, limit: 2 });
    const last = first.at(-1);
    const rest = await queries.listForCustomer({
      customerId: "customer-1",
      after: last ? { placedAt: last.placedAt, orderId: last.orderId } : null,
      limit: 2,
    });

    expect([...first, ...rest].map((summary) => summary.orderId)).toEqual(["order-3", "order-2", "order-1"]);
  });
});
```

## Wiring

- **Outbound.** `PrismaOrderQueries`, `TypeOrmOrderQueries` or `DrizzleOrderQueries` in the persistence guides, section 7, backed by an index on `(customer_id, placed_at DESC, id DESC)`.
- **HTTP.** `GET /orders?limit=20&cursor=...` returning `{ "items": [...], "nextCursor": "..." | null }`. Validate `limit` at the edge (`z.coerce.number().int().min(1).max(100)`). `InvalidCursorError` is a `DomainError`, so the family mapping returns 422.
- **Security.** Take `customerId` from the authenticated principal, never from the query string, or any user can list anyone's orders.
- **Composition.** `new ListOrdersUseCase(new PrismaOrderQueries(prisma))`.
