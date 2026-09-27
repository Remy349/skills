# Prisma persistence adapter guide

Targets Prisma 7 (the `prisma-client` generator, driver adapters and `prisma.config.ts`) with PostgreSQL. The domain classes in `../idioms.md` stay free of Prisma: generated types never leave `adapters/outbound/prisma/`.

Prisma is neither Active Record nor a classic Data Mapper: it returns plain objects typed from the schema. Treat them as persistence records and map them to the domain explicitly.

## Contents
1. Detection and setup
2. Schema and mappers
3. Repository adapter
4. Unit of Work (interactive transactions)
5. Error translation
6. Optimistic concurrency
7. Outbox, read queries and idempotency
8. Integration tests
9. Migrations
10. Pitfalls

## 1. Detection and setup

`prisma` and `@prisma/client` in the dependencies, a `prisma/schema.prisma`. Check the version: Prisma 7 requires an explicit generator `output`, a driver adapter (`@prisma/adapter-pg` for PostgreSQL) and reads its CLI settings from `prisma.config.ts`; Prisma 6 and earlier generate into `node_modules/.prisma` and connect without an adapter. Keep the project's version; the adapter structure below is the same.

Generate the client **inside the adapter folder**, so only the adapter can import it:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/orders/adapters/outbound/prisma/generated"
}

datasource db {
  provider = "postgresql"
}
```

```ts
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/shop" },
});
```

```typescript
// src/orders/adapters/outbound/prisma/client.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export type { Prisma } from "./generated/client.js";

export const createPrismaClient = (connectionString: string): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

export { PrismaClient };
```

Add the generated folder to `.gitignore` and run `prisma generate` in `postinstall` or the build.

## 2. Schema and mappers

Models are named `*Record` to make clear they are persistence shapes; `@@map` and `@map` keep SQL names in snake_case.

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/orders/adapters/outbound/prisma/generated"
}

datasource db {
  provider = "postgresql"
}

model OrderRecord {
  id         String            @id @db.VarChar(36)
  customerId String            @map("customer_id") @db.VarChar(64)
  status     String            @db.VarChar(16)
  currency   String            @db.Char(3)
  totalCents Int               @map("total_cents")
  placedAt   DateTime          @map("placed_at") @db.Timestamptz(6)
  paymentId  String?           @map("payment_id") @db.VarChar(64)
  version    Int
  lines      OrderLineRecord[]

  @@index([customerId, placedAt(sort: Desc), id(sort: Desc)])
  @@map("orders")
}

model OrderLineRecord {
  orderId        String      @map("order_id") @db.VarChar(36)
  position       Int
  sku            String      @db.VarChar(64)
  quantity       Int
  unitPriceCents Int         @map("unit_price_cents")
  order          OrderRecord @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@id([orderId, position])
  @@map("order_lines")
}
```

Mapping is explicit, both ways, in one module. `rehydrate` rebuilds the aggregate without re-running creation rules:

```typescript
// src/orders/adapters/outbound/prisma/mappers.ts
import { Money } from "../../../domain/money.js";
import { Order, OrderId, OrderLine, type OrderStatus } from "../../../domain/order.js";
import type { Prisma } from "./generated/client.js";

type OrderWithLines = Prisma.OrderRecordGetPayload<{ include: { lines: true } }>;

export const toDomain = (record: OrderWithLines): Order =>
  Order.rehydrate({
    id: OrderId(record.id),
    customerId: record.customerId,
    lines: [...record.lines]
      .sort((a, b) => a.position - b.position)
      .map((line) =>
        OrderLine.of({
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: Money.of(line.unitPriceCents, record.currency),
        }),
      ),
    status: record.status as OrderStatus,
    placedAt: record.placedAt,
    version: record.version,
    paymentId: record.paymentId,
  });

export const toCreateInput = (order: Order): Prisma.OrderRecordCreateInput => ({
  id: order.id,
  customerId: order.customerId,
  status: order.status,
  currency: order.total.currency,
  totalCents: order.total.amount,
  placedAt: order.placedAt,
  paymentId: order.paymentId,
  version: order.version + 1,
  lines: {
    create: order.lines.map((line, position) => ({
      position,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unitPrice.amount,
    })),
  },
});
```

## 3. Repository adapter

One repository per aggregate root. It receives the transaction client from the unit of work, never opens its own transaction, and returns domain objects only.

```typescript
// src/orders/adapters/outbound/prisma/order.repository.ts
import type { OrderRepository } from "../../../application/ports.js";
import type { Order, OrderId } from "../../../domain/order.js";
import { ConflictError } from "../../../../shared-kernel/errors.js";
import { Prisma } from "./generated/client.js";
import { toCreateInput, toDomain } from "./mappers.js";

export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async get(id: OrderId): Promise<Order | null> {
    const record = await this.tx.orderRecord.findUnique({ where: { id }, include: { lines: true } });
    return record ? toDomain(record) : null;
  }

  async add(order: Order): Promise<void> {
    try {
      await this.tx.orderRecord.create({ data: toCreateInput(order) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError(`order ${order.id} already exists`, { cause: error });
      }
      throw error;
    }
  }

  async update(order: Order): Promise<void> {
    // Compare-and-set on the version column: the row changes only if nobody else changed it first.
    const { count } = await this.tx.orderRecord.updateMany({
      where: { id: order.id, version: order.version },
      data: { status: order.status, paymentId: order.paymentId, version: order.version + 1 },
    });
    if (count !== 1) throw new ConflictError(`order ${order.id} was modified concurrently`);
  }
}
```

`update` writes only what can change after creation. When a use case can change lines, update them in the same method (`deleteMany` + `createMany` on the lines inside the transaction).

## 4. Unit of Work (interactive transactions)

`$transaction(async (tx) => ...)` commits when the callback resolves and rolls back when it rejects: the same contract as the `UnitOfWork` port.

```typescript
// src/orders/adapters/outbound/prisma/unit-of-work.ts
import type { TransactionScope, UnitOfWork } from "../../../application/ports.js";
import type { PrismaClient } from "./generated/client.js";
import { PrismaOrderRepository } from "./order.repository.js";

/** Interactive transaction: commits when `work` resolves, rolls back when it rejects. */
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work({ orders: new PrismaOrderRepository(tx) }));
  }
}
```

Interactive transactions hold a connection for their whole duration and have a default timeout (5 s). Keep the work inside short, and never call a remote API inside it (see `../recipes/external-api-acl.md`).

## 5. Error translation

| Technology error | Translate to | Where |
|---|---|---|
| `PrismaClientKnownRequestError` code `P2002` (unique constraint) | `ConflictError` (or a context-specific subclass) | `add`, `reserve` |
| Zero rows from a versioned `updateMany` | `ConflictError` | `update` |
| `P2025` (record not found) from `update`/`delete` | the context's not-found error, if the use case expects it | where it can happen |
| Connection and timeout errors | let them propagate; the central handler returns 500/503 | nowhere |

Import the error classes from the generated client's `Prisma` namespace and keep the original as `cause`.

## 6. Optimistic concurrency

The aggregate carries the `version` it was loaded with. `updateMany({ where: { id, version } })` changes the row only if the version still matches and returns the count; `count !== 1` means another transaction won. `update({ where: { id, version } })` also works (non-unique filters are allowed next to the unique `id`), but it signals the conflict by throwing `P2025`, which you would then have to tell apart from a genuinely missing row; the count is clearer.

## 7. Outbox, read queries and idempotency

These adapters back the recipes. Add the models to the schema:

```prisma
model OutboxMessage {
  id          BigInt    @id @default(autoincrement())
  eventType   String    @map("event_type") @db.VarChar(64)
  payload     Json
  occurredAt  DateTime  @map("occurred_at") @db.Timestamptz(6)
  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)

  @@index([publishedAt])
  @@map("outbox")
}

model IdempotencyKey {
  scope       String @db.VarChar(64)
  key         String @db.VarChar(128)
  fingerprint String @db.VarChar(64)
  response    Json?

  @@id([scope, key])
  @@map("idempotency_keys")
}
```

**Outbox** (`../recipes/domain-events-outbox.md`). It writes through the same transaction client as the repository, so events commit with the aggregate:

```typescript
// src/orders/adapters/outbound/prisma/outbox.ts
import type { Outbox } from "../../../application/ports.js";
import type { DomainEvent } from "../../../domain/events.js";
import { toIntegrationEvent } from "../integration-events.js";
import type { Prisma } from "./generated/client.js";

/** Stores events in the same transaction as the aggregate; a relay publishes them after commit. */
export class PrismaOutbox implements Outbox {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async add(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.tx.outboxMessage.createMany({
      data: events.map((event) => {
        const { type, payload } = toIntegrationEvent(event);
        return { eventType: type, payload: payload as Prisma.InputJsonObject, occurredAt: event.occurredAt };
      }),
    });
  }
}
```

The unit of work then exposes it: `work({ orders: new PrismaOrderRepository(tx), outbox: new PrismaOutbox(tx) })`.

The relay runs in a worker. Prisma has no API for `FOR UPDATE SKIP LOCKED`, so the claim is a raw query inside the transaction:

```typescript
// src/orders/adapters/outbound/prisma/outbox.relay.ts
import type { PrismaClient } from "./generated/client.js";

export interface MessagePublisher {
  publish(message: { messageId: string; type: string; payload: unknown }): Promise<void>;
}

/** Runs in a worker, not in the request path. At-least-once: consumers deduplicate by messageId. */
export class PrismaOutboxRelay {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: MessagePublisher,
    private readonly batchSize = 100,
  ) {}

  async publishPending(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // SKIP LOCKED lets several relays run in parallel without publishing the same row twice.
      const rows = await tx.$queryRaw<{ id: bigint; event_type: string; payload: unknown }[]>`
        SELECT id, event_type, payload FROM outbox
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        await this.publisher.publish({ messageId: row.id.toString(), type: row.event_type, payload: row.payload });
      }
      if (rows.length > 0) {
        await tx.outboxMessage.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: { publishedAt: new Date() },
        });
      }
      return rows.length;
    });
  }
}
```

If publishing succeeds and the commit then fails, the batch is published again: at-least-once delivery, which is why consumers deduplicate by `messageId`.

**Read queries** (`../recipes/read-model-pagination.md`). Select only the columns the screen needs; keyset pagination on `(placedAt, id)`:

```typescript
// src/orders/adapters/outbound/prisma/order.queries.ts
import type { OrderQueries, OrderSummary, Position } from "../../../application/list-orders.use-case.js";
import type { PrismaClient } from "./generated/client.js";

/** Read adapter: selects only the columns the screen needs, no aggregate loading. */
export class PrismaOrderQueries implements OrderQueries {
  constructor(private readonly prisma: PrismaClient) {}

  async listForCustomer(input: { customerId: string; after: Position | null; limit: number }): Promise<OrderSummary[]> {
    const { after } = input;
    const rows = await this.prisma.orderRecord.findMany({
      where: {
        customerId: input.customerId,
        ...(after && {
          OR: [{ placedAt: { lt: after.placedAt } }, { placedAt: after.placedAt, id: { lt: after.orderId } }],
        }),
      },
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: { id: true, status: true, totalCents: true, currency: true, placedAt: true },
    });
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

**Idempotency keys** (`../recipes/idempotent-command.md`). The composite primary key makes `reserve` atomic across concurrent requests:

```typescript
// src/orders/adapters/outbound/prisma/idempotency.store.ts
import type { IdempotencyRecord, IdempotencyStore } from "../../../application/idempotency.js";
import type { PlaceOrderOutput } from "../../../application/place-order.use-case.js";
import { Prisma, type PrismaClient } from "./generated/client.js";

/** The primary key on (scope, key) makes `reserve` atomic across concurrent requests. */
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async reserve(input: { scope: string; key: string; fingerprint: string }): Promise<IdempotencyRecord | null> {
    try {
      await this.prisma.idempotencyKey.create({ data: { ...input, response: Prisma.DbNull } });
      return null;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
    const row = await this.prisma.idempotencyKey.findUniqueOrThrow({
      where: { scope_key: { scope: input.scope, key: input.key } },
    });
    return { fingerprint: row.fingerprint, response: row.response as PlaceOrderOutput | null };
  }

  async complete(input: { scope: string; key: string; response: PlaceOrderOutput }): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { scope_key: { scope: input.scope, key: input.key } },
      data: { response: input.response },
    });
  }

  async release(input: { scope: string; key: string }): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({ where: { scope: input.scope, key: input.key } });
  }
}
```

`Prisma.DbNull` stores SQL `NULL` in a nullable `Json` column (a plain `null` is ambiguous for JSON fields). Expire old keys with a scheduled `deleteMany`.

## 8. Integration tests

Run the shared contract suite (`../testing.md`, section 5) against PostgreSQL in a container, with `prisma migrate deploy` applying the real migrations (`../testing.md`, section 6). Also test: rollback of a rejected unit of work, duplicate id → `ConflictError`, stale version → `ConflictError`, and read queries paging across ties in `placedAt`.

## 9. Migrations

- `prisma migrate dev --name <change>` creates and applies a migration in development; review the generated SQL before committing it.
- `prisma migrate deploy` applies pending migrations in CI, tests and production. Run it as a deployment step, not at application startup.
- `prisma db push` is for prototypes only: it changes the schema without a migration history.
- In Prisma 7, `migrate dev` no longer runs `generate`; run `prisma generate` explicitly (or from `postinstall`).

## 10. Pitfalls

- **Generated types in the application layer** (`OrderRecord` as a use case return type, `Prisma.TransactionClient` in a port): the core now depends on the schema. Ports speak domain types only.
- **A `PrismaService` injected into controllers or use cases**: controllers call use cases; use cases call ports.
- **`upsert` or `update` for aggregates**: `upsert` hides duplicate-id conflicts and `update` cannot check the version; use `create` and a versioned `updateMany`.
- **Nested writes that change several aggregates** in one call: one aggregate per transaction.
- **Long or remote work inside `$transaction`**: connection held, timeout errors, and no atomicity with the remote system anyway.
- **Relying on `include` to load everything**: repositories load exactly the aggregate; read queries select exactly the screen's columns.
