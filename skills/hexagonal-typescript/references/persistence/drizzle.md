# Drizzle persistence adapter guide

Targets Drizzle ORM 0.45 with `drizzle-kit` 0.31 and PostgreSQL through `node-postgres`. The domain classes in `../idioms.md` stay free of Drizzle: table definitions and inferred row types never leave `adapters/outbound/drizzle/`.

Drizzle is a typed SQL query builder: it has no entities with behavior, which makes the Data Mapper split natural. Rows are plain objects; map them to the domain explicitly.

## Contents
1. Detection
2. Schema and mappers
3. Repository adapter
4. Unit of Work
5. Error translation
6. Optimistic concurrency
7. Outbox, read queries and idempotency
8. Integration tests
9. Migrations
10. Pitfalls

## 1. Detection

`drizzle-orm` (and usually `drizzle-kit`) in the dependencies, a `drizzle.config.ts`, and `pgTable(...)` definitions. Drizzle 1.0 is in release candidates at the time of writing; check the installed version and its release notes before copying APIs between major versions.

## 2. Schema and mappers

```typescript
// src/orders/adapters/outbound/drizzle/schema.ts
import { char, index, integer, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

// Persistence schema: table definitions only. Row types are inferred and never leave this folder.
export const orders = pgTable(
  "orders",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    customerId: varchar("customer_id", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    totalCents: integer("total_cents").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    paymentId: varchar("payment_id", { length: 64 }),
    version: integer("version").notNull(),
  },
  (table) => [index("orders_customer_placed_idx").on(table.customerId, table.placedAt.desc(), table.id.desc())],
);

export const orderLines = pgTable(
  "order_lines",
  {
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    sku: varchar("sku", { length: 64 }).notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
  },
  (table) => [primaryKey({ columns: [table.orderId, table.position] })],
);

export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;
```

```typescript
// src/orders/adapters/outbound/drizzle/database.ts
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
/** Repositories accept either, so they work inside and outside a transaction. */
export type Executor = Database | Transaction;

export const createDatabase = (connectionString: string): { db: Database; pool: Pool } => {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
};
```

`Executor` lets a repository run on the database or inside a transaction with the same code.

```typescript
// src/orders/adapters/outbound/drizzle/mappers.ts
import { Money } from "../../../domain/money.js";
import { Order, OrderId, OrderLine, type OrderStatus } from "../../../domain/order.js";
import type { OrderLineRow, OrderRow } from "./schema.js";

export const toDomain = (row: OrderRow, lines: readonly OrderLineRow[]): Order =>
  Order.rehydrate({
    id: OrderId(row.id),
    customerId: row.customerId,
    lines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((line) =>
        OrderLine.of({
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: Money.of(line.unitPriceCents, row.currency),
        }),
      ),
    status: row.status as OrderStatus,
    placedAt: row.placedAt,
    version: row.version,
    paymentId: row.paymentId,
  });

export const toRows = (order: Order): { order: OrderRow; lines: OrderLineRow[] } => ({
  order: {
    id: order.id,
    customerId: order.customerId,
    status: order.status,
    currency: order.total.currency,
    totalCents: order.total.amount,
    placedAt: order.placedAt,
    paymentId: order.paymentId,
    version: order.version + 1,
  },
  lines: order.lines.map((line, position) => ({
    orderId: order.id,
    position,
    sku: line.sku,
    quantity: line.quantity,
    unitPriceCents: line.unitPrice.amount,
  })),
});
```

## 3. Repository adapter

```typescript
// src/orders/adapters/outbound/drizzle/errors.ts
import { DrizzleQueryError } from "drizzle-orm/errors";

const UNIQUE_VIOLATION = "23505"; // PostgreSQL SQLSTATE

/** Drizzle wraps driver errors in DrizzleQueryError; the pg error with its SQLSTATE is the cause. */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof DrizzleQueryError && (error.cause as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;
```

```typescript
// src/orders/adapters/outbound/drizzle/order.repository.ts
import { and, eq } from "drizzle-orm";
import type { OrderRepository } from "../../../application/ports.js";
import type { Order, OrderId } from "../../../domain/order.js";
import { ConflictError } from "../../../../shared-kernel/errors.js";
import type { Executor } from "./database.js";
import { isUniqueViolation } from "./errors.js";
import { toDomain, toRows } from "./mappers.js";
import { orderLines, orders } from "./schema.js";

export class DrizzleOrderRepository implements OrderRepository {
  constructor(private readonly db: Executor) {}

  async get(id: OrderId): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, id));
    if (!row) return null;
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, id));
    return toDomain(row, lines);
  }

  async add(order: Order): Promise<void> {
    const rows = toRows(order);
    try {
      await this.db.insert(orders).values(rows.order);
      await this.db.insert(orderLines).values(rows.lines);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`order ${order.id} already exists`, { cause: error });
      throw error;
    }
  }

  async update(order: Order): Promise<void> {
    // Compare-and-set on the version column: the row changes only if nobody else changed it first.
    const updated = await this.db
      .update(orders)
      .set({ status: order.status, paymentId: order.paymentId, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
      .returning({ id: orders.id });
    if (updated.length !== 1) throw new ConflictError(`order ${order.id} was modified concurrently`);
  }
}
```

Loading the aggregate takes two small queries (order, then lines). The relational query API (`db.query.orders.findFirst({ with: { lines: true } })`) does it in one call if you declare `relations(...)`; either is fine inside the adapter.

## 4. Unit of Work

`db.transaction(async (tx) => ...)` commits when the callback resolves and rolls back when it rejects:

```typescript
// src/orders/adapters/outbound/drizzle/unit-of-work.ts
import type { TransactionScope, UnitOfWork } from "../../../application/ports.js";
import type { Database } from "./database.js";
import { DrizzleOrderRepository } from "./order.repository.js";

/** One transaction per call: commits when `work` resolves, rolls back when it rejects. */
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work({ orders: new DrizzleOrderRepository(tx) }));
  }
}
```

Composition:

```typescript
// src/orders/composition.ts
import type { Database } from "./adapters/outbound/drizzle/database.js";
import { DrizzleUnitOfWork } from "./adapters/outbound/drizzle/unit-of-work.js";
import { SystemClock, UuidIdGenerator } from "./adapters/outbound/system.js";
import { PlaceOrderUseCase } from "./application/place-order.use-case.js";

export type OrdersModule = {
  readonly placeOrder: PlaceOrderUseCase;
};

/** The only module of the context that knows concrete adapters. Built once at startup. */
export const buildOrdersModule = (deps: { db: Database }): OrdersModule => {
  const uow = new DrizzleUnitOfWork(deps.db);
  return { placeOrder: new PlaceOrderUseCase(uow, new UuidIdGenerator(), new SystemClock()) };
};
```

Create the pool with `createDatabase(url)` in `main.ts` and call `pool.end()` on shutdown.

## 5. Error translation

| Technology error | Translate to | Where |
|---|---|---|
| `DrizzleQueryError` whose `cause.code` is `23505` (unique violation) | `ConflictError` | `add` |
| Empty `returning()` from a versioned `update` | `ConflictError` | `update` |
| Connection and timeout errors | let them propagate | nowhere |

Drizzle wraps driver errors in `DrizzleQueryError`; the PostgreSQL error with its SQLSTATE `code` is the `cause`. Checking `error.code` on the outer error finds nothing.

## 6. Optimistic concurrency

`update(...).where(and(eq(id), eq(version)))` with `.returning()` tells how many rows changed; zero means another transaction won. PostgreSQL's `returning` is the portable way to get that count here.

## 7. Outbox, read queries and idempotency

These adapters back the recipes; add the tables to the schema:

```ts
// src/orders/adapters/outbound/drizzle/schema.ts  (addition)
import { bigserial, jsonb } from "drizzle-orm/pg-core";

export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [index("outbox_published_at_idx").on(table.publishedAt)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope: varchar("scope", { length: 64 }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
);
```

**Outbox**:

```typescript
// src/orders/adapters/outbound/drizzle/outbox.ts
import type { Outbox } from "../../../application/ports.js";
import type { DomainEvent } from "../../../domain/events.js";
import { toIntegrationEvent } from "../integration-events.js";
import type { Executor } from "./database.js";
import { outbox } from "./schema.js";

/** Stores events in the same transaction as the aggregate; a relay publishes them after commit. */
export class DrizzleOutbox implements Outbox {
  constructor(private readonly db: Executor) {}

  async add(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.insert(outbox).values(
      events.map((event) => {
        const { type, payload } = toIntegrationEvent(event);
        return { eventType: type, payload, occurredAt: event.occurredAt };
      }),
    );
  }
}
```

The unit of work then exposes it: `work({ orders: new DrizzleOrderRepository(tx), outbox: new DrizzleOutbox(tx) })`. For the relay, `tx.select().from(outbox).where(isNull(outbox.publishedAt)).orderBy(outbox.id).limit(n).for("update", { skipLocked: true })` claims a batch inside a transaction.

**Read queries** (keyset pagination; `and()` ignores `undefined` conditions, which keeps the optional cursor readable):

```typescript
// src/orders/adapters/outbound/drizzle/order.queries.ts
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { OrderQueries, OrderSummary, Position } from "../../../application/list-orders.use-case.js";
import type { Database } from "./database.js";
import { orders } from "./schema.js";

/** Read adapter: selects only the columns the screen needs, no aggregate loading. */
export class DrizzleOrderQueries implements OrderQueries {
  constructor(private readonly db: Database) {}

  async listForCustomer(input: { customerId: string; after: Position | null; limit: number }): Promise<OrderSummary[]> {
    const { after } = input;
    const rows = await this.db
      .select({
        orderId: orders.id,
        status: orders.status,
        totalCents: orders.totalCents,
        currency: orders.currency,
        placedAt: orders.placedAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.customerId, input.customerId),
          after
            ? or(
                lt(orders.placedAt, after.placedAt),
                and(eq(orders.placedAt, after.placedAt), lt(orders.id, after.orderId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(orders.placedAt), desc(orders.id))
      .limit(input.limit);
    return rows;
  }
}
```

**Idempotency keys** (`onConflictDoNothing().returning()` reserves atomically without catching errors):

```typescript
// src/orders/adapters/outbound/drizzle/idempotency.store.ts
import { and, eq } from "drizzle-orm";
import type { IdempotencyRecord, IdempotencyStore } from "../../../application/idempotency.js";
import type { PlaceOrderOutput } from "../../../application/place-order.use-case.js";
import type { Database } from "./database.js";
import { idempotencyKeys } from "./schema.js";

/** The primary key on (scope, key) makes `reserve` atomic across concurrent requests. */
export class DrizzleIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database) {}

  async reserve(input: { scope: string; key: string; fingerprint: string }): Promise<IdempotencyRecord | null> {
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({ ...input, response: null })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length === 1) return null;
    const [row] = await this.db.select().from(idempotencyKeys).where(this.byKey(input));
    if (!row) throw new Error(`idempotency key ${input.scope}/${input.key} vanished`);
    return { fingerprint: row.fingerprint, response: row.response as PlaceOrderOutput | null };
  }

  async complete(input: { scope: string; key: string; response: PlaceOrderOutput }): Promise<void> {
    await this.db.update(idempotencyKeys).set({ response: input.response }).where(this.byKey(input));
  }

  async release(input: { scope: string; key: string }): Promise<void> {
    await this.db.delete(idempotencyKeys).where(this.byKey(input));
  }

  private byKey(input: { scope: string; key: string }) {
    return and(eq(idempotencyKeys.scope, input.scope), eq(idempotencyKeys.key, input.key));
  }
}
```

## 8. Integration tests

Run the shared contract suite against PostgreSQL in a container, applying the real SQL migrations with Drizzle's migrator:

```typescript
// test/integration/drizzle-order-repository.test.ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, createDatabase } from "../../src/orders/adapters/outbound/drizzle/database.js";
import { DrizzleOrderRepository } from "../../src/orders/adapters/outbound/drizzle/order.repository.js";
import { DrizzleUnitOfWork } from "../../src/orders/adapters/outbound/drizzle/unit-of-work.js";
import { OrderId } from "../../src/orders/domain/order.js";
import { anOrder } from "../orders/builders.js";
import { describeOrderRepositoryContract } from "../orders/order-repository.contract.js";

let container: StartedPostgreSqlContainer;
let db: Database;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  ({ db, pool } = createDatabase(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: "migrations/drizzle" }); // real migrations
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describeOrderRepositoryContract("DrizzleOrderRepository", {
  reset: async () => {
    await db.execute(sql`TRUNCATE orders, order_lines RESTART IDENTITY CASCADE`);
  },
  withRepository: (use) => db.transaction((tx) => use(new DrizzleOrderRepository(tx))),
});

describe("DrizzleUnitOfWork", () => {
  it("rolls back everything when the work rejects", async () => {
    const uow = new DrizzleUnitOfWork(db);

    await expect(
      uow.run(async ({ orders }) => {
        await orders.add(anOrder({ id: "rolled-back" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await uow.run(({ orders }) => orders.get(OrderId("rolled-back")))).toBeNull();
  });
});
```

## 9. Migrations

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/orders/adapters/outbound/drizzle/schema.ts",
  out: "./migrations/drizzle",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
});
```

- `drizzle-kit generate --name <change>` writes SQL migrations from the schema; review them and commit them.
- Apply them with `drizzle-kit migrate` or programmatically with `migrate(db, { migrationsFolder })` as a deployment step.
- `drizzle-kit push` is for prototypes only: it changes the database without a migration history.

## 10. Pitfalls

- **Inferred row types (`typeof orders.$inferSelect`) in ports or use cases**: the core now depends on the schema. Ports speak domain types.
- **Passing `db` into use cases** to "just run a query": use cases depend on ports; queries belong in adapters.
- **Using the root `db` inside a transaction callback** instead of `tx`: writes escape the transaction.
- **Checking `error.code` on `DrizzleQueryError`**: the SQLSTATE is on `error.cause`.
- **One schema file shared by several bounded contexts**: each context owns its tables; share ids, not table definitions.
