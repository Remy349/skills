# Recipe: domain events and the transactional outbox

## Problem

When an order is placed, other parts of the system must react: send an email, reserve stock, update a projection in another service. Publishing to a broker inside the request either happens before the commit (the event describes something that may roll back) or after it (a crash in between loses the event).

## Use it when / skip it when

- Use when: another bounded context or service must learn about a change reliably; you need an audit trail of business facts.
- Skip when: the side effect is local and can run in the same transaction, or losing an occasional notification is acceptable. Do not add a broker for a single in-process listener.

## Design

1. **The aggregate records domain events** as it changes (`OrderPlaced`, `OrderPaid`, `OrderCancelled`). The base `Order` in `../idioms.md` already does this; `pullEvents()` hands them over once.
2. **The use case writes events to an outbox** through a port that is part of the transaction scope. The unit of work commits both or neither.
3. **The adapter translates domain events into integration events**: explicit, versioned payloads (the published language). Domain events can change freely; integration events are a contract.
4. **A relay publishes** unpublished outbox rows to the broker and marks them published. Delivery is at-least-once.
5. **Consumers are idempotent**: they record processed message ids and skip duplicates.

## Code

The domain events (already part of the base slice):

```typescript
// src/orders/domain/events.ts
import type { Money } from "./money.js";

export type OrderPlaced = {
  readonly type: "OrderPlaced";
  readonly orderId: string;
  readonly customerId: string;
  readonly total: Money;
  readonly occurredAt: Date;
};

export type OrderPaid = {
  readonly type: "OrderPaid";
  readonly orderId: string;
  readonly paymentId: string;
  readonly occurredAt: Date;
};

export type OrderCancelled = {
  readonly type: "OrderCancelled";
  readonly orderId: string;
  readonly reason: string;
  readonly occurredAt: Date;
};

export type DomainEvent = OrderPlaced | OrderPaid | OrderCancelled;
```

The outbox port joins the transaction scope, so it shares the unit of work's transaction:

```typescript
// src/orders/application/ports.ts
import type { DomainEvent } from "../domain/events.js";
import type { Order, OrderId } from "../domain/order.js";

export interface OrderRepository {
  get(id: OrderId): Promise<Order | null>;
  /** Insert a new order. Rejects with ConflictError if the id already exists. */
  add(order: Order): Promise<void>;
  /** Persist changes. Rejects with ConflictError if the stored version is not `order.version`. */
  update(order: Order): Promise<void>;
}

export interface Outbox {
  add(events: readonly DomainEvent[]): Promise<void>;
}

/** What a use case can touch inside one transaction. */
export interface TransactionScope {
  readonly orders: OrderRepository;
  readonly outbox: Outbox;
}

export interface UnitOfWork {
  /** Runs `work` in one transaction: commits when it resolves, rolls back when it rejects. */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export interface IdGenerator {
  newId(): string;
}

export interface Clock {
  now(): Date;
}
```

Every use case that changes an aggregate adds its events before the unit of work commits. `PlaceOrderUseCase` becomes:

```typescript
// src/orders/application/place-order.use-case.ts
import { Money } from "../domain/money.js";
import { Order, OrderId, OrderLine } from "../domain/order.js";
import type { Clock, IdGenerator, UnitOfWork } from "./ports.js";

export type PlaceOrderInput = {
  readonly customerId: string;
  readonly currency: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number; readonly unitPriceCents: number }[];
};

export type PlaceOrderOutput = {
  readonly orderId: string;
  readonly totalCents: number;
  readonly currency: string;
};

export class PlaceOrderUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: PlaceOrderInput): Promise<PlaceOrderOutput> {
    const order = Order.create({
      id: OrderId(this.ids.newId()),
      customerId: input.customerId,
      lines: input.lines.map((line) =>
        OrderLine.of({
          sku: line.sku,
          quantity: line.quantity,
          unitPrice: Money.of(line.unitPriceCents, input.currency),
        }),
      ),
      now: this.clock.now(),
    });
    await this.uow.run(async ({ orders, outbox }) => {
      await orders.add(order);
      await outbox.add(order.pullEvents());
    });
    return { orderId: order.id, totalCents: order.total.amount, currency: order.total.currency };
  }
}
```

Add the same call, `await outbox.add(order.pullEvents())`, inside the unit of work of `CancelOrderUseCase`, `PayOrderUseCase` and any other command.

The translation to integration events lives in the outbound adapter layer. The `never` check turns a forgotten event type into a compile error:

```typescript
// src/orders/adapters/outbound/integration-events.ts
import type { DomainEvent } from "../../domain/events.js";

export type JsonScalar = string | number | boolean | null;

export type IntegrationEvent = { readonly type: string; readonly payload: Record<string, JsonScalar> };

/** Published language: explicit, versioned payloads. Changing a domain event must not break consumers. */
export const toIntegrationEvent = (event: DomainEvent): IntegrationEvent => {
  switch (event.type) {
    case "OrderPlaced":
      return {
        type: "orders.order_placed.v1",
        payload: {
          orderId: event.orderId,
          customerId: event.customerId,
          totalCents: event.total.amount,
          currency: event.total.currency,
          occurredAt: event.occurredAt.toISOString(),
        },
      };
    case "OrderPaid":
      return {
        type: "orders.order_paid.v1",
        payload: { orderId: event.orderId, paymentId: event.paymentId, occurredAt: event.occurredAt.toISOString() },
      };
    case "OrderCancelled":
      return {
        type: "orders.order_cancelled.v1",
        payload: { orderId: event.orderId, reason: event.reason, occurredAt: event.occurredAt.toISOString() },
      };
    default: {
      const unhandled: never = event; // compile error when a new event type is not mapped
      throw new Error(`no integration event for ${JSON.stringify(unhandled)}`);
    }
  }
};
```

The outbox tables, adapters and relays for Prisma, TypeORM and Drizzle are in each persistence guide, section 7.

## Tests

The fake unit of work gains an outbox that, like the real one, only keeps events of committed work:

```ts
// test/support/fakes.ts  (addition)
import type { Outbox } from "../../src/orders/application/ports.js";
import type { DomainEvent } from "../../src/orders/domain/events.js";

export class InMemoryOutbox implements Outbox {
  events: DomainEvent[] = [];

  async add(events: readonly DomainEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

/** Stages writes and applies them only when the work resolves, like a real transaction. */
export class FakeUnitOfWork implements UnitOfWork {
  commits = 0;

  constructor(
    readonly orders = new InMemoryOrderRepository(),
    readonly outbox = new InMemoryOutbox(),
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const staged = new InMemoryOrderRepository();
    staged.rows = new Map(this.orders.rows);
    const stagedOutbox = new InMemoryOutbox();
    const result = await work({ orders: staged, outbox: stagedOutbox });
    this.orders.rows = staged.rows;
    this.outbox.events.push(...stagedOutbox.events);
    this.commits += 1;
    return result;
  }
}
```

`FakeUnitOfWork` replaces the version in `../testing.md`. Use case tests assert on the committed outbox:

```ts
it("stores OrderPlaced in the outbox in the same transaction", async () => {
  await placeOrder.execute(aPlaceOrderInput());

  expect(uow.outbox.events.map((event) => event.type)).toEqual(["OrderPlaced"]);
});
```

Adapter tests against PostgreSQL prove atomicity and relay behavior (Prisma shown; the other ORMs are the same test with their adapters). `usePrisma()` starts the container, applies migrations and truncates tables before each test:

```typescript
// test/support/prisma.ts
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { type PrismaClient, createPrismaClient } from "../../src/orders/adapters/outbound/prisma/client.js";
import { startPostgres } from "./postgres.js";

/** Registers container lifecycle hooks for the current test file and returns an accessor for the client. */
export const usePrisma = (): (() => PrismaClient) => {
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

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE orders, order_lines, outbox, idempotency_keys RESTART IDENTITY CASCADE`;
  });

  return () => prisma;
};
```

```typescript
// test/integration/prisma-outbox.test.ts
import { describe, expect, it } from "vitest";
import { type MessagePublisher, PrismaOutboxRelay } from "../../src/orders/adapters/outbound/prisma/outbox.relay.js";
import { PrismaUnitOfWork } from "../../src/orders/adapters/outbound/prisma/unit-of-work.js";
import { PlaceOrderUseCase } from "../../src/orders/application/place-order.use-case.js";
import { aPlaceOrderInput } from "../orders/builders.js";
import { FixedClock, SequentialIds } from "../support/fakes.js";
import { usePrisma } from "../support/prisma.js";

const prisma = usePrisma();

const placeOrder = () => new PlaceOrderUseCase(new PrismaUnitOfWork(prisma()), new SequentialIds(), new FixedClock());

describe("outbox with Prisma", () => {
  it("commits the order and its integration event together", async () => {
    await placeOrder().execute(aPlaceOrderInput());

    const messages = await prisma().outboxMessage.findMany();
    expect(messages.map((m) => [m.eventType, (m.payload as { totalCents: number }).totalCents])).toEqual([
      ["orders.order_placed.v1", 3000],
    ]);
  });

  it("publishes each pending message once", async () => {
    await placeOrder().execute(aPlaceOrderInput());
    const published: string[] = [];
    const publisher: MessagePublisher = { publish: async (message) => void published.push(message.type) };
    const relay = new PrismaOutboxRelay(prisma(), publisher);

    expect(await relay.publishPending()).toBe(1);
    expect(await relay.publishPending()).toBe(0);
    expect(published).toEqual(["orders.order_placed.v1"]);
  });
});
```

## Wiring

- **Relay process.** Run `publishPending()` in a loop or on a schedule in a separate worker (a CLI entry point, a container sidecar, a scheduled job). It is an inbound adapter driven by time, not by HTTP.
- **Publisher.** Implement `MessagePublisher` for your broker (RabbitMQ, Kafka, SNS/SQS, Redis Streams, NATS). Pass `messageId` as the broker's message id or a header so consumers can deduplicate.
- **Consumers.** In the consuming context the message handler is an inbound adapter: insert the `messageId` into a `processed_messages` table (unique) in the same transaction as the handler's changes, and skip the message when the insert conflicts.
- **Retention.** Delete published outbox rows after a retention window with a scheduled job.
