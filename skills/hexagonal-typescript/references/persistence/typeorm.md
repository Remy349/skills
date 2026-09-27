# TypeORM persistence adapter guide

Targets TypeORM 1.x (0.3.x has the same APIs used here) with PostgreSQL. The domain classes in `../idioms.md` stay free of TypeORM: entity definitions never leave `adapters/outbound/typeorm/`.

TypeORM supports both Active Record (`BaseEntity.save()`) and Data Mapper (repositories and the `EntityManager`). Use **Data Mapper**, with persistence rows separate from domain objects, and map explicitly.

## Contents
1. Detection
2. Entity schemas and mappers
3. Repository adapter
4. Unit of Work
5. Error translation
6. Optimistic concurrency
7. Outbox, read queries and idempotency
8. Integration tests
9. Migrations
10. Pitfalls

## 1. Detection

`typeorm` in the dependencies; a `DataSource` definition; entities as decorated classes (`@Entity()`) or `EntitySchema` objects. Keep the project's style; the adapter structure is the same.

## 2. Entity schemas and mappers

`EntitySchema` describes tables with plain objects: row types are ordinary TypeScript types and nothing depends on decorator metadata. Decorated entity classes are equally valid if the project uses them; the rule is the same, they live in this folder and are never returned by repositories.

```typescript
// src/orders/adapters/outbound/typeorm/entities.ts
import { EntitySchema } from "typeorm";

// Persistence models: plain row shapes plus a schema. They never leave this folder.
export type OrderRow = {
  id: string;
  customerId: string;
  status: string;
  currency: string;
  totalCents: number;
  placedAt: Date;
  paymentId: string | null;
  version: number;
  lines: OrderLineRow[];
};

export type OrderLineRow = {
  orderId: string;
  position: number;
  sku: string;
  quantity: number;
  unitPriceCents: number;
};

export const OrderEntity = new EntitySchema<OrderRow>({
  name: "Order",
  tableName: "orders",
  columns: {
    id: { type: "varchar", length: 36, primary: true },
    customerId: { name: "customer_id", type: "varchar", length: 64 },
    status: { type: "varchar", length: 16 },
    currency: { type: "char", length: 3 },
    totalCents: { name: "total_cents", type: "int" },
    placedAt: { name: "placed_at", type: "timestamptz" },
    paymentId: { name: "payment_id", type: "varchar", length: 64, nullable: true },
    version: { type: "int" },
  },
  relations: {
    lines: { type: "one-to-many", target: "OrderLine", inverseSide: "order", cascade: ["insert"], eager: true },
  },
  indices: [{ columns: ["customerId", "placedAt", "id"] }],
});

export const OrderLineEntity = new EntitySchema<OrderLineRow & { order?: OrderRow }>({
  name: "OrderLine",
  tableName: "order_lines",
  columns: {
    orderId: { name: "order_id", type: "varchar", length: 36, primary: true },
    position: { type: "int", primary: true },
    sku: { type: "varchar", length: 64 },
    quantity: { type: "int" },
    unitPriceCents: { name: "unit_price_cents", type: "int" },
  },
  relations: {
    order: { type: "many-to-one", target: "Order", joinColumn: { name: "order_id" }, onDelete: "CASCADE" },
  },
});

export const entities = [OrderEntity, OrderLineEntity];
```

```typescript
// src/orders/adapters/outbound/typeorm/mappers.ts
import { Money } from "../../../domain/money.js";
import { Order, OrderId, OrderLine, type OrderStatus } from "../../../domain/order.js";
import type { OrderRow } from "./entities.js";

export const toDomain = (row: OrderRow): Order =>
  Order.rehydrate({
    id: OrderId(row.id),
    customerId: row.customerId,
    lines: [...row.lines]
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

export const toRow = (order: Order): OrderRow => ({
  id: order.id,
  customerId: order.customerId,
  status: order.status,
  currency: order.total.currency,
  totalCents: order.total.amount,
  placedAt: order.placedAt,
  paymentId: order.paymentId,
  version: order.version + 1,
  lines: order.lines.map((line, position) => ({
    orderId: order.id,
    position,
    sku: line.sku,
    quantity: line.quantity,
    unitPriceCents: line.unitPrice.amount,
  })),
});
```

```typescript
// src/orders/adapters/outbound/typeorm/data-source.ts
import { DataSource } from "typeorm";
import { entities } from "./entities.js";

export const createDataSource = (url: string): DataSource =>
  new DataSource({
    type: "postgres",
    url,
    entities,
    migrations: ["dist/migrations/typeorm/*.js"],
    synchronize: false, // schema changes go through migrations, never through synchronize
  });
```

## 3. Repository adapter

One repository per aggregate root, working on the `EntityManager` of the current transaction:

```typescript
// src/orders/adapters/outbound/typeorm/errors.ts
import { QueryFailedError } from "typeorm";

const UNIQUE_VIOLATION = "23505"; // PostgreSQL SQLSTATE

export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof QueryFailedError && (error.driverError as { code?: string }).code === UNIQUE_VIOLATION;
```

```typescript
// src/orders/adapters/outbound/typeorm/order.repository.ts
import type { EntityManager } from "typeorm";
import type { OrderRepository } from "../../../application/ports.js";
import type { Order, OrderId } from "../../../domain/order.js";
import { ConflictError } from "../../../../shared-kernel/errors.js";
import { OrderEntity, OrderLineEntity } from "./entities.js";
import { isUniqueViolation } from "./errors.js";
import { toDomain, toRow } from "./mappers.js";

export class TypeOrmOrderRepository implements OrderRepository {
  constructor(private readonly manager: EntityManager) {}

  async get(id: OrderId): Promise<Order | null> {
    const row = await this.manager.findOne(OrderEntity, { where: { id } });
    return row ? toDomain(row) : null;
  }

  async add(order: Order): Promise<void> {
    const { lines, ...row } = toRow(order);
    try {
      // Plain INSERTs: `save()` would silently update an existing row instead of reporting the conflict.
      await this.manager.insert(OrderEntity, row);
      await this.manager.insert(OrderLineEntity, lines);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`order ${order.id} already exists`, { cause: error });
      throw error;
    }
  }

  async update(order: Order): Promise<void> {
    // Compare-and-set on the version column: the row changes only if nobody else changed it first.
    const result = await this.manager.update(
      OrderEntity,
      { id: order.id, version: order.version },
      { status: order.status, paymentId: order.paymentId, version: order.version + 1 },
    );
    if (result.affected !== 1) throw new ConflictError(`order ${order.id} was modified concurrently`);
  }
}
```

## 4. Unit of Work

`dataSource.transaction(async (manager) => ...)` commits when the callback resolves and rolls back when it rejects:

```typescript
// src/orders/adapters/outbound/typeorm/unit-of-work.ts
import type { DataSource } from "typeorm";
import type { TransactionScope, UnitOfWork } from "../../../application/ports.js";
import { TypeOrmOrderRepository } from "./order.repository.js";

/** One transaction per call: commits when `work` resolves, rolls back when it rejects. */
export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.dataSource.transaction((manager) => work({ orders: new TypeOrmOrderRepository(manager) }));
  }
}
```

Every repository created inside the callback must use that `manager`. Using the global `dataSource.manager` inside a transaction silently writes outside it.

Composition:

```typescript
// src/orders/composition.ts
import type { DataSource } from "typeorm";
import { TypeOrmUnitOfWork } from "./adapters/outbound/typeorm/unit-of-work.js";
import { SystemClock, UuidIdGenerator } from "./adapters/outbound/system.js";
import { PlaceOrderUseCase } from "./application/place-order.use-case.js";

export type OrdersModule = {
  readonly placeOrder: PlaceOrderUseCase;
};

/** The only module of the context that knows concrete adapters. Built once at startup. */
export const buildOrdersModule = (deps: { dataSource: DataSource }): OrdersModule => {
  const uow = new TypeOrmUnitOfWork(deps.dataSource);
  return { placeOrder: new PlaceOrderUseCase(uow, new UuidIdGenerator(), new SystemClock()) };
};
```

Call `await dataSource.initialize()` in `main.ts` before building the module and `await dataSource.destroy()` on shutdown.

## 5. Error translation

| Technology error | Translate to | Where |
|---|---|---|
| `QueryFailedError` whose `driverError.code` is `23505` (PostgreSQL unique violation) | `ConflictError` | `add`, `reserve` |
| `affected !== 1` from a versioned `update` | `ConflictError` | `update` |
| `EntityNotFoundError` from `findOneOrFail` | the context's not-found error, if expected | where it can happen |
| Connection and timeout errors | let them propagate | nowhere |

## 6. Optimistic concurrency

`manager.update(Entity, { id, version }, changes)` issues `UPDATE ... WHERE id = $1 AND version = $2` and reports `affected`. TypeORM's `@VersionColumn` increments a version on `save()`, but `save()` does not fail on a stale version; the explicit criteria above are what make concurrent writes fail.

## 7. Outbox, read queries and idempotency

These adapters back the recipes; add their entity schemas to `entities.ts`:

```ts
// src/orders/adapters/outbound/typeorm/entities.ts  (addition)
type JsonObject = Record<string, string | number | boolean | null>;

export type OutboxRow = {
  id: string;
  eventType: string;
  payload: JsonObject;
  occurredAt: Date;
  publishedAt: Date | null;
};

export type IdempotencyRow = {
  scope: string;
  key: string;
  fingerprint: string;
  response: JsonObject | null;
};

export const OutboxEntity = new EntitySchema<OutboxRow>({
  name: "OutboxMessage",
  tableName: "outbox",
  columns: {
    id: { type: "bigint", primary: true, generated: "increment" },
    eventType: { name: "event_type", type: "varchar", length: 64 },
    payload: { type: "jsonb" },
    occurredAt: { name: "occurred_at", type: "timestamptz" },
    publishedAt: { name: "published_at", type: "timestamptz", nullable: true },
  },
  indices: [{ columns: ["publishedAt"] }],
});

export const IdempotencyEntity = new EntitySchema<IdempotencyRow>({
  name: "IdempotencyKey",
  tableName: "idempotency_keys",
  columns: {
    scope: { type: "varchar", length: 64, primary: true },
    key: { type: "varchar", length: 128, primary: true },
    fingerprint: { type: "varchar", length: 64 },
    response: { type: "jsonb", nullable: true },
  },
});
```

Typing JSON columns as `Record<string, string | number | boolean | null>` rather than `Record<string, unknown>` keeps TypeORM's `insert` typings happy.

**Outbox**:

```typescript
// src/orders/adapters/outbound/typeorm/outbox.ts
import type { EntityManager } from "typeorm";
import type { Outbox } from "../../../application/ports.js";
import type { DomainEvent } from "../../../domain/events.js";
import { toIntegrationEvent } from "../integration-events.js";
import { OutboxEntity } from "./entities.js";

/** Stores events in the same transaction as the aggregate; a relay publishes them after commit. */
export class TypeOrmOutbox implements Outbox {
  constructor(private readonly manager: EntityManager) {}

  async add(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.manager.insert(
      OutboxEntity,
      events.map((event) => {
        const { type, payload } = toIntegrationEvent(event);
        return { eventType: type, payload, occurredAt: event.occurredAt };
      }),
    );
  }
}
```

The unit of work then exposes it: `work({ orders: new TypeOrmOrderRepository(manager), outbox: new TypeOrmOutbox(manager) })`. For the relay, claim rows with `createQueryBuilder(OutboxEntity, "o").setLock("pessimistic_write").setOnLocked("skip_locked")` inside a transaction, publish, then set `publishedAt`.

**Read queries** (keyset pagination with a row-value comparison):

```typescript
// src/orders/adapters/outbound/typeorm/order.queries.ts
import type { DataSource } from "typeorm";
import type { OrderQueries, OrderSummary, Position } from "../../../application/list-orders.use-case.js";
import { OrderEntity } from "./entities.js";

/** Read adapter: selects only the columns the screen needs, no aggregate loading. */
export class TypeOrmOrderQueries implements OrderQueries {
  constructor(private readonly dataSource: DataSource) {}

  async listForCustomer(input: { customerId: string; after: Position | null; limit: number }): Promise<OrderSummary[]> {
    const query = this.dataSource
      .createQueryBuilder(OrderEntity, "o")
      .select(["o.id", "o.status", "o.totalCents", "o.currency", "o.placedAt"])
      .where("o.customerId = :customerId", { customerId: input.customerId })
      .orderBy("o.placedAt", "DESC")
      .addOrderBy("o.id", "DESC")
      .take(input.limit);
    if (input.after) {
      query.andWhere("(o.placedAt, o.id) < (:placedAt, :orderId)", {
        placedAt: input.after.placedAt,
        orderId: input.after.orderId,
      });
    }
    const rows = await query.getMany();
    return rows.map((row) => ({
      orderId: row.id,
      status: row.status,
      totalCents: row.totalCents,
      currency: row.currency,
      placedAt: row.placedAt,
    }));
  }
}
```

**Idempotency keys**:

```typescript
// src/orders/adapters/outbound/typeorm/idempotency.store.ts
import type { DataSource } from "typeorm";
import type { IdempotencyRecord, IdempotencyStore } from "../../../application/idempotency.js";
import type { PlaceOrderOutput } from "../../../application/place-order.use-case.js";
import { IdempotencyEntity } from "./entities.js";
import { isUniqueViolation } from "./errors.js";

/** The primary key on (scope, key) makes `reserve` atomic across concurrent requests. */
export class TypeOrmIdempotencyStore implements IdempotencyStore {
  constructor(private readonly dataSource: DataSource) {}

  async reserve(input: { scope: string; key: string; fingerprint: string }): Promise<IdempotencyRecord | null> {
    try {
      await this.dataSource.manager.insert(IdempotencyEntity, { ...input, response: null });
      return null;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const row = await this.dataSource.manager.findOneByOrFail(IdempotencyEntity, {
      scope: input.scope,
      key: input.key,
    });
    return { fingerprint: row.fingerprint, response: row.response as PlaceOrderOutput | null };
  }

  async complete(input: { scope: string; key: string; response: PlaceOrderOutput }): Promise<void> {
    await this.dataSource.manager.update(
      IdempotencyEntity,
      { scope: input.scope, key: input.key },
      { response: input.response },
    );
  }

  async release(input: { scope: string; key: string }): Promise<void> {
    await this.dataSource.manager.delete(IdempotencyEntity, { scope: input.scope, key: input.key });
  }
}
```

## 8. Integration tests

Run the shared contract suite against PostgreSQL in a container with the real migrations:

```typescript
// test/integration/typeorm-order-repository.test.ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDataSource } from "../../src/orders/adapters/outbound/typeorm/data-source.js";
import { TypeOrmOrderRepository } from "../../src/orders/adapters/outbound/typeorm/order.repository.js";
import { TypeOrmUnitOfWork } from "../../src/orders/adapters/outbound/typeorm/unit-of-work.js";
import { OrderId } from "../../src/orders/domain/order.js";
import { anOrder } from "../orders/builders.js";
import { describeOrderRepositoryContract } from "../orders/order-repository.contract.js";

let container: StartedPostgreSqlContainer;
let dataSource: DataSource;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  dataSource = createDataSource(container.getConnectionUri());
  await dataSource.initialize();
  await dataSource.runMigrations(); // real migrations, never synchronize
}, 120_000);

afterAll(async () => {
  await dataSource?.destroy();
  await container?.stop();
});

describeOrderRepositoryContract("TypeOrmOrderRepository", {
  reset: async () => {
    await dataSource.query("TRUNCATE orders, order_lines RESTART IDENTITY CASCADE");
  },
  withRepository: (use) => dataSource.transaction((manager) => use(new TypeOrmOrderRepository(manager))),
});

describe("TypeOrmUnitOfWork", () => {
  it("rolls back everything when the work rejects", async () => {
    const uow = new TypeOrmUnitOfWork(dataSource);

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

`runMigrations()` loads the compiled migrations configured in the data source (`dist/migrations/typeorm/*.js`), so build before running integration tests, or point `migrations` at the `.ts` files when tests run through a TypeScript loader.

## 9. Migrations

- `synchronize: false`, always. Schema changes go through migrations.
- Generate from the entity definitions against a database at the current schema: `typeorm migration:generate migrations/typeorm/<Name> -d dist/.../cli-data-source.js`, where the CLI data source is a module that default-exports a `DataSource`:

```typescript
// src/orders/adapters/outbound/typeorm/cli-data-source.ts
// Entry point for the TypeORM CLI (migration:generate / migration:run), compiled to dist/.
import { createDataSource } from "./data-source.js";

export default createDataSource(process.env["DATABASE_URL"] ?? "");
```

- **With `verbatimModuleSyntax`**, generated migrations fail to compile because they import types as values (`import { MigrationInterface, QueryRunner } from "typeorm"`). Change that line to `import type { ... }` after generating.
- Review generated SQL, then run `typeorm migration:run -d ...` as a deployment step.

## 10. Pitfalls

- **`save()` for inserts**: it selects first and updates if the id exists, hiding duplicate-id conflicts. Use `insert()`.
- **Entities with business methods, or domain classes decorated with `@Entity()`**: persistence and rules become one class. Keep rows in this folder and map.
- **Lazy relations or `eager` relations crossing aggregates**: load exactly one aggregate per repository call.
- **The global `dataSource.manager` inside a transaction callback**: writes escape the transaction.
- **`Repository<T>` injected into controllers or use cases** (a common NestJS pattern): only adapters touch TypeORM.
