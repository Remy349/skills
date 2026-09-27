# Testing a hexagonal TypeScript service

Tooling for this language. The strategy (what to test at each boundary, fakes vs mocks, CI order) is in `testing-strategy.md`; framework test clients are in `frameworks/`.

## Contents
1. Tools
2. Layout and naming
3. Fakes for every port
4. Test data builders
5. Contract suites shared by fakes and real adapters
6. Integration tests with PostgreSQL in a container
7. Outbound HTTP adapters
8. CI commands

## 1. Tools

| Need | Tool |
|---|---|
| Runner, assertions, mocks | Vitest (or the Jest setup the project already has) |
| HTTP adapter tests | `supertest` (Express, NestJS), `app.inject()` (Fastify) |
| Real database | `@testcontainers/postgresql` + the ORM's migration tool |
| Outbound HTTP | inject `fetch` into the adapter and pass a scripted function; MSW or `nock` for code you cannot change |
| Properties of value objects | `fast-check` |
| Architecture | dependency-cruiser (`idioms.md`, section 8) |
| Mutation testing for critical rules | Stryker |

Freeze time with an injected `FixedClock`; use `vi.useFakeTimers()` only for code that schedules timers.

## 2. Layout and naming

```
test/
  support/
    fakes.ts                         # one fake per port, reused everywhere
    postgres.ts                      # container + migrations helper
  orders/
    builders.ts                      # valid defaults for domain objects and inputs
    order.test.ts                    # pure domain rules
    place-order.use-case.test.ts     # use cases with fakes
    order-repository.contract.ts     # shared contract suite (not a test file itself)
    in-memory-order-repository.test.ts
    http-adapter.test.ts
  integration/
    prisma-order-repository.test.ts  # real adapters against PostgreSQL
```

`describe` names the unit, `it` states the behavior: `it("rejects an order without lines and stores nothing")`. One behavior per test; Arrange, Act, Assert separated by blank lines.

## 3. Fakes for every port

Fakes are working in-memory implementations that `implements` the port. They behave like the real thing where it matters: the repository copies on read and write so tests cannot share state by accident, and the unit of work applies changes only when the work resolves.

```typescript
// test/support/fakes.ts
import type {
  Clock,
  IdGenerator,
  OrderRepository,
  TransactionScope,
  UnitOfWork,
} from "../../src/orders/application/ports.js";
import { Order, type OrderId } from "../../src/orders/domain/order.js";
import { ConflictError } from "../../src/shared-kernel/errors.js";

/** Copies on read and write, and keeps state, not pending events, like a database. */
export class InMemoryOrderRepository implements OrderRepository {
  rows = new Map<OrderId, Order>();

  async get(id: OrderId): Promise<Order | null> {
    const stored = this.rows.get(id);
    return stored ? copy(stored) : null;
  }

  async add(order: Order): Promise<void> {
    if (this.rows.has(order.id)) throw new ConflictError(`order ${order.id} already exists`);
    this.store(order);
  }

  async update(order: Order): Promise<void> {
    if (this.rows.get(order.id)?.version !== order.version) {
      throw new ConflictError(`order ${order.id} was modified concurrently`);
    }
    this.store(order);
  }

  private store(order: Order): void {
    this.rows.set(order.id, copy(order, order.version + 1)); // same version rule as the SQL adapters
  }
}

const copy = (order: Order, version = order.version): Order =>
  Order.rehydrate({
    id: order.id,
    customerId: order.customerId,
    lines: order.lines,
    status: order.status,
    placedAt: order.placedAt,
    version,
    paymentId: order.paymentId,
  });

/** Stages writes and applies them only when the work resolves, like a real transaction. */
export class FakeUnitOfWork implements UnitOfWork {
  commits = 0;

  constructor(readonly orders = new InMemoryOrderRepository()) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const staged = new InMemoryOrderRepository();
    staged.rows = new Map(this.orders.rows);
    const result = await work({ orders: staged });
    this.orders.rows = staged.rows;
    this.commits += 1;
    return result;
  }
}

export class SequentialIds implements IdGenerator {
  private next = 0;

  constructor(private readonly prefix = "order") {}

  newId(): string {
    this.next += 1;
    return `${this.prefix}-${this.next}`;
  }
}

export class FixedClock implements Clock {
  constructor(public current = new Date("2026-01-15T12:00:00Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
```

Recipes add fakes for their own ports (`InMemoryOutbox`, `FakePaymentGateway`, `InMemoryOrderQueries`, `InMemoryIdempotencyStore`) in the same module.

Use `vi.fn()` only to verify an interaction that has no observable outcome, and never mock a type you do not own (`PrismaClient`, `fetch` responses from a real vendor schema you have not pinned): wrap it in a port and fake the port.

## 4. Test data builders

Valid defaults in one place; each test overrides only what it is about.

```typescript
// test/orders/builders.ts
import type { PlaceOrderInput } from "../../src/orders/application/place-order.use-case.js";
import { Money } from "../../src/orders/domain/money.js";
import { Order, OrderId, OrderLine } from "../../src/orders/domain/order.js";

export const NOW = new Date("2026-01-15T12:00:00Z");

export const aLine = (
  overrides: { sku?: string; quantity?: number; unitPriceCents?: number; currency?: string } = {},
) =>
  OrderLine.of({
    sku: overrides.sku ?? "SKU-1",
    quantity: overrides.quantity ?? 1,
    unitPrice: Money.of(overrides.unitPriceCents ?? 1000, overrides.currency ?? "USD"),
  });

export const anOrder = (overrides: { id?: string; customerId?: string; lines?: OrderLine[] } = {}) =>
  Order.create({
    id: OrderId(overrides.id ?? "order-1"),
    customerId: overrides.customerId ?? "customer-1",
    lines: overrides.lines ?? [aLine()],
    now: NOW,
  });

export const aPlaceOrderInput = (overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
  customerId: "customer-1",
  currency: "USD",
  lines: [{ sku: "SKU-1", quantity: 2, unitPriceCents: 1500 }],
  ...overrides,
});
```

## 5. Contract suites shared by fakes and real adapters

A port's contract is more than its signature: what `get` returns for an unknown id, whether `add` rejects duplicates, how stale versions fail. Write it once as a function that declares the tests; every implementation calls it with a small harness.

```typescript
// test/orders/order-repository.contract.ts
import { beforeEach, describe, expect, it } from "vitest";
import type { OrderRepository } from "../../src/orders/application/ports.js";
import { OrderId } from "../../src/orders/domain/order.js";
import { ConflictError } from "../../src/shared-kernel/errors.js";
import { NOW, aLine, anOrder } from "./builders.js";

export type RepositoryHarness = {
  /** Empty the storage before each test. */
  reset(): Promise<void>;
  /** Run `use` with a repository; real adapters wrap it in a committed transaction. */
  withRepository<T>(use: (repository: OrderRepository) => Promise<T>): Promise<T>;
};

/** Contract every OrderRepository implementation must honor, the in-memory fake included. */
export const describeOrderRepositoryContract = (name: string, harness: RepositoryHarness) => {
  const { withRepository } = harness;

  describe(`${name} honors the OrderRepository contract`, () => {
    beforeEach(() => harness.reset());

    it("finds a saved order by id with the same state", async () => {
      const order = anOrder({ lines: [aLine({ quantity: 2 }), aLine({ sku: "SKU-2", unitPriceCents: 5 })] });

      await withRepository((repository) => repository.add(order));
      const found = await withRepository((repository) => repository.get(order.id));

      expect(found?.customerId).toBe(order.customerId);
      expect(found?.lines).toEqual(order.lines);
      expect(found?.status).toBe("pending");
      expect(found?.total.equals(order.total)).toBe(true);
      expect(found?.placedAt).toEqual(NOW);
    });

    it("returns null for an unknown id", async () => {
      expect(await withRepository((repository) => repository.get(OrderId("missing")))).toBeNull();
    });

    it("rejects a duplicate id with ConflictError", async () => {
      await withRepository((repository) => repository.add(anOrder({ id: "order-1" })));

      await expect(withRepository((repository) => repository.add(anOrder({ id: "order-1" })))).rejects.toThrow(
        ConflictError,
      );
    });

    it("persists changes and bumps the version", async () => {
      await withRepository((repository) => repository.add(anOrder({ id: "order-1" })));

      await withRepository(async (repository) => {
        const order = await repository.get(OrderId("order-1"));
        order?.pay({ paymentId: "pay-1", now: NOW });
        if (order) await repository.update(order);
      });

      const updated = await withRepository((repository) => repository.get(OrderId("order-1")));
      expect([updated?.status, updated?.paymentId, updated?.version]).toEqual(["paid", "pay-1", 2]);
    });

    it("rejects an update based on a stale version", async () => {
      await withRepository((repository) => repository.add(anOrder({ id: "order-1" })));
      const first = await withRepository((repository) => repository.get(OrderId("order-1")));
      const second = await withRepository((repository) => repository.get(OrderId("order-1")));
      first?.cancel({ reason: "first writer", now: NOW });
      second?.pay({ paymentId: "pay-1", now: NOW });

      await withRepository(async (repository) => first && repository.update(first));

      await expect(withRepository(async (repository) => second && repository.update(second))).rejects.toThrow(
        ConflictError,
      );
    });
  });
};
```

```typescript
// test/orders/in-memory-order-repository.test.ts
import { InMemoryOrderRepository } from "../support/fakes.js";
import { describeOrderRepositoryContract } from "./order-repository.contract.js";

let repository = new InMemoryOrderRepository();

describeOrderRepositoryContract("InMemoryOrderRepository", {
  reset: async () => {
    repository = new InMemoryOrderRepository();
  },
  withRepository: (use) => use(repository),
});
```

The real adapters run the same suite in `test/integration/` (see the persistence guides).

## 6. Integration tests with PostgreSQL in a container

Test SQL adapters against the database you run in production, with the real migrations applied. An in-memory or SQLite substitute differs in types, time zones, locking and constraint behavior.

```typescript
// test/support/postgres.ts
import { execFileSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** Starts PostgreSQL in a container and applies the real migrations. */
export const startPostgres = async (): Promise<StartedPostgreSqlContainer> => {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: "ignore",
  });
  return container;
};
```

```typescript
// test/integration/prisma-order-repository.test.ts
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll } from "vitest";
import { type PrismaClient, createPrismaClient } from "../../src/orders/adapters/outbound/prisma/client.js";
import { PrismaOrderRepository } from "../../src/orders/adapters/outbound/prisma/order.repository.js";
import { describeOrderRepositoryContract } from "../orders/order-repository.contract.js";
import { startPostgres } from "../support/postgres.js";

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await startPostgres();
  prisma = createPrismaClient(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

describeOrderRepositoryContract("PrismaOrderRepository", {
  reset: async () => {
    await prisma.$executeRaw`TRUNCATE orders, order_lines RESTART IDENTITY CASCADE`;
  },
  withRepository: (use) => prisma.$transaction((tx) => use(new PrismaOrderRepository(tx))),
});
```

- Starting a container takes seconds: start one per test file in `beforeAll`, clean tables in the harness `reset`.
- Keep integration tests in their own folder so the default local run can exclude them (`vitest run test/orders`) while CI runs everything.
- Docker must be available. In CI use a runner with Docker, or a service container and a `DATABASE_URL`.

## 7. Outbound HTTP adapters

Give HTTP adapters an injectable `fetch` (defaulting to the global one). Tests pass a function that returns scripted `Response` objects, so the real adapter code runs with no network and no extra library:

```ts
const fetch = async () => Response.json({ decline_code: "insufficient_funds" }, { status: 402 });

await expect(gateway(fetch).authorize(charge)).rejects.toThrow(PaymentDeclinedError);
```

Cover success, each mapped error status, timeouts and malformed bodies. The full example is in `recipes/external-api-acl.md`.

## 8. CI commands

```bash
npx tsc --noEmit
npx eslint .                                      # or: npx biome check .
npx depcruise src --config .dependency-cruiser.cjs
npx vitest run test/orders test/catalog           # domain, use cases, HTTP adapters: seconds
npx vitest run test/integration                   # containers
```
