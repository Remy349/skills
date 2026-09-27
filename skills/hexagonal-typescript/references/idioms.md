# TypeScript idioms, layout and the base slice

Targets TypeScript 5.x to 7.x on Node.js 20+ with ES modules. Nothing in this file imports a web framework, an ORM or a validation library: it is the core every framework guide and recipe builds on.

## Contents
1. Tooling
2. Naming and style
3. Layout
4. Base vertical slice: PlaceOrder
5. Composition root
6. Errors
7. Pitfalls
8. Architecture enforcement

## 1. Tooling

- **Package manager**: follow the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`).
- **Modules**: follow the project. For new code prefer ES modules (`"type": "module"`, `"module": "nodenext"`), which means relative imports end in `.js` even in `.ts` files. Some libraries (NestJS 12, Vitest, Zod) now ship as ESM.
- **Compiler**: strict settings; `tsc --noEmit` is the type check in CI.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

  Add `"experimentalDecorators": true` and `"emitDecoratorMetadata": true` only when a framework needs them (NestJS, decorator-based TypeORM entities).
- **Lint and format**: keep what exists (Prettier + ESLint with `typescript-eslint`, or Biome). Enable the rules against floating and misused promises.
- **Tests**: Vitest (or the Jest setup already present); see `testing.md`.
- **Architecture**: dependency-cruiser (section 8).

## 2. Naming and style

- Files `kebab-case` with a role suffix the project already uses: `place-order.use-case.ts`, `order.repository.ts`, `orders.controller.ts`. Types, classes and interfaces `PascalCase`; functions, methods and variables `camelCase`; module-level constants `UPPER_SNAKE_CASE`.
- **No `I` prefix** on interfaces (`OrderRepository`, not `IOrderRepository`). Adapters carry the technology (`PrismaOrderRepository`, `HttpPaymentGateway`); fakes say what they are (`InMemoryOrderRepository`, `FixedClock`).
- Use cases are **verbs** with one `execute` method (`PlaceOrderUseCase`). Ports are **capabilities** (`OrderRepository`, `PaymentGateway`, `Clock`).
- String-literal unions for closed sets (`"pending" | "paid" | "cancelled"`) instead of `enum`. Discriminated unions for events. `readonly` everywhere data should not change.
- **Branded ids** where mixing ids is a real risk: `type OrderId = string & { readonly __brand: "OrderId" }`.
- Money in integer minor units (`amountCents`) or a decimal library; never a float. Dates in UTC from an injected clock.
- `unknown` instead of `any` at boundaries, narrowed with `instanceof` or a schema. `catch (error)` is `unknown`.
- Named exports. Avoid barrel files (`index.ts`) that re-export whole layers: they hide dependency direction and create cycles.

## 3. Layout

Feature first (bounded context), then layer.

```
src/
  shared-kernel/
    errors.ts                   # error families shared by all contexts (tiny, stable)
  orders/                       # bounded context
    domain/
      errors.ts  money.ts  events.ts  order.ts
    application/
      ports.ts                  # outbound ports + unit of work (one file per port is also fine)
      place-order.use-case.ts   # one use case per file: input, output, class
    adapters/
      inbound/http/             # routes/controllers, request schemas, error mapping
      outbound/
        prisma/                 # client, mappers, repositories, unit of work (or typeorm/, drizzle/)
        system.ts               # UUID generator, system clock
    composition.ts              # builds this context's use cases from concrete adapters
  catalog/                      # another context, same shape (or a thin slice)
  bootstrap/
    config.ts  app.ts  main.ts  # validated config, framework app factory, process entry point
test/
  support/fakes.ts              # in-memory implementations of every port
  orders/                       # domain, use case, adapter and contract tests
  integration/                  # tests against real infrastructure in containers
```

## 4. Base vertical slice: PlaceOrder

The recipes extend this slice. Domain first: no imports outside the domain and the shared kernel.

```typescript
// src/shared-kernel/errors.ts
/** An expected business failure. `code` is stable and part of the API contract. */
export class DomainError extends Error {
  readonly code: string = "DOMAIN_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  override readonly code: string = "NOT_FOUND";
}

/** The request conflicts with the current state: duplicate, stale version or forbidden transition. */
export class ConflictError extends DomainError {
  override readonly code: string = "CONFLICT";
}
```

The HTTP adapter maps these **families** (not-found → 404, conflict → 409, any other `DomainError` → 422), so adding an error to a context never touches the adapter.

```typescript
// src/orders/domain/errors.ts
import { ConflictError, DomainError, NotFoundError } from "../../shared-kernel/errors.js";

export class InvalidMoneyError extends DomainError {
  override readonly code = "MONEY_INVALID";
}

export class InvalidOrderError extends DomainError {
  override readonly code = "ORDER_INVALID";
}

export class OrderNotFoundError extends NotFoundError {
  override readonly code = "ORDER_NOT_FOUND";
}

export class InvalidOrderTransitionError extends ConflictError {
  override readonly code = "ORDER_INVALID_TRANSITION";
}

export class StaleOrderError extends ConflictError {
  override readonly code = "ORDER_STALE";
}
```

```typescript
// src/orders/domain/money.ts
import { InvalidMoneyError } from "./errors.js";

/** Amount in minor units (cents) plus an ISO 4217 currency code. Never a float. */
export class Money {
  private constructor(
    readonly amount: number,
    readonly currency: string,
  ) {}

  static of(amount: number, currency: string): Money {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new InvalidMoneyError("amount must be a non-negative integer of minor units");
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError(`invalid currency code: ${currency}`);
    }
    return new Money(amount, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  add(other: Money): Money {
    if (other.currency !== this.currency) {
      throw new InvalidMoneyError(`cannot add ${other.currency} to ${this.currency}`);
    }
    return Money.of(this.amount + other.amount, this.currency);
  }

  times(quantity: number): Money {
    return Money.of(this.amount * quantity, this.currency);
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }
}
```

Domain events are a discriminated union. The aggregate records them as facts; publishing them reliably is the job of `recipes/domain-events-outbox.md`.

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

```typescript
// src/orders/domain/order.ts
import { InvalidOrderError, InvalidOrderTransitionError } from "./errors.js";
import type { DomainEvent } from "./events.js";
import type { Money } from "./money.js";

export type OrderId = string & { readonly __brand: "OrderId" };
export const OrderId = (value: string): OrderId => value as OrderId;

export type OrderStatus = "pending" | "paid" | "cancelled";

export class OrderLine {
  private constructor(
    readonly sku: string,
    readonly quantity: number,
    readonly unitPrice: Money,
  ) {}

  static of(props: { sku: string; quantity: number; unitPrice: Money }): OrderLine {
    if (props.sku.length === 0) throw new InvalidOrderError("sku is required");
    if (!Number.isInteger(props.quantity) || props.quantity <= 0) {
      throw new InvalidOrderError("quantity must be a positive integer");
    }
    return new OrderLine(props.sku, props.quantity, props.unitPrice);
  }

  get subtotal(): Money {
    return this.unitPrice.times(this.quantity);
  }
}

type NonEmpty<T> = readonly [T, ...T[]];

const isNonEmpty = <T>(items: readonly T[]): items is NonEmpty<T> => items.length > 0;

/** Stored state, used by persistence adapters to rehydrate an order. */
export type OrderSnapshot = {
  readonly id: OrderId;
  readonly customerId: string;
  readonly lines: readonly OrderLine[];
  readonly status: OrderStatus;
  readonly placedAt: Date;
  readonly version: number;
  readonly paymentId: string | null;
};

type OrderState = OrderSnapshot & { readonly lines: NonEmpty<OrderLine> };

/** Aggregate root. Build it with `create` (applies business rules) or `rehydrate` (loads stored state). */
export class Order {
  private events: DomainEvent[] = [];

  private constructor(private state: OrderState) {}

  static create(props: { id: OrderId; customerId: string; lines: readonly OrderLine[]; now: Date }): Order {
    const { lines } = props;
    if (!isNonEmpty(lines)) throw new InvalidOrderError("an order needs at least one line");
    if (lines.some((line) => line.unitPrice.currency !== lines[0].unitPrice.currency)) {
      throw new InvalidOrderError("all lines must use the same currency");
    }
    const order = new Order({
      id: props.id,
      customerId: props.customerId,
      lines,
      status: "pending",
      placedAt: props.now,
      version: 0,
      paymentId: null,
    });
    order.record({
      type: "OrderPlaced",
      orderId: props.id,
      customerId: props.customerId,
      total: order.total,
      occurredAt: props.now,
    });
    return order;
  }

  static rehydrate(snapshot: OrderSnapshot): Order {
    const { lines } = snapshot;
    if (!isNonEmpty(lines)) throw new InvalidOrderError(`stored order ${snapshot.id} has no lines`);
    return new Order({ ...snapshot, lines });
  }

  get id(): OrderId {
    return this.state.id;
  }
  get customerId(): string {
    return this.state.customerId;
  }
  get lines(): readonly OrderLine[] {
    return this.state.lines;
  }
  get status(): OrderStatus {
    return this.state.status;
  }
  get placedAt(): Date {
    return this.state.placedAt;
  }
  /** Version loaded from storage; 0 for a new order. */
  get version(): number {
    return this.state.version;
  }
  get paymentId(): string | null {
    return this.state.paymentId;
  }

  get total(): Money {
    const [first, ...rest] = this.state.lines;
    return rest.reduce((sum, line) => sum.add(line.subtotal), first.subtotal);
  }

  pay(props: { paymentId: string; now: Date }): void {
    this.ensureStatus("pending", "pay");
    this.state = { ...this.state, status: "paid", paymentId: props.paymentId };
    this.record({ type: "OrderPaid", orderId: this.id, paymentId: props.paymentId, occurredAt: props.now });
  }

  cancel(props: { reason: string; now: Date }): void {
    this.ensureStatus("pending", "cancel");
    this.state = { ...this.state, status: "cancelled" };
    this.record({ type: "OrderCancelled", orderId: this.id, reason: props.reason, occurredAt: props.now });
  }

  pullEvents(): DomainEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  private ensureStatus(expected: OrderStatus, action: string): void {
    if (this.state.status !== expected) {
      throw new InvalidOrderTransitionError(`cannot ${action} an order that is ${this.state.status}`);
    }
  }

  private record(event: DomainEvent): void {
    this.events.push(event);
  }
}
```

Design notes:
- The constructor is private: `create` enforces the business rules, `rehydrate` restores stored state (and still refuses structurally impossible data such as an order without lines).
- `NonEmpty<OrderLine>` makes "an order has at least one line" a type, so `total` needs no fallback.
- State changes only through `pay` and `cancel`; getters expose it read-only.

Ports belong to the application layer and speak domain types. The unit of work takes a callback: it commits when the callback resolves and rolls back when it rejects, which is exactly how Prisma, TypeORM and Drizzle transactions work.

```typescript
// src/orders/application/ports.ts
import type { Order, OrderId } from "../domain/order.js";

export interface OrderRepository {
  get(id: OrderId): Promise<Order | null>;
  /** Insert a new order. Rejects with ConflictError if the id already exists. */
  add(order: Order): Promise<void>;
  /** Persist changes. Rejects with ConflictError if the stored version is not `order.version`. */
  update(order: Order): Promise<void>;
}

/** What a use case can touch inside one transaction. */
export interface TransactionScope {
  readonly orders: OrderRepository;
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
    await this.uow.run(({ orders }) => orders.add(order));
    return { orderId: order.id, totalCents: order.total.amount, currency: order.total.currency };
  }
}
```

The slice is testable now, before any adapter exists. Fakes live in `test/support/fakes.ts` (full versions in `testing.md`):

```typescript
// test/orders/place-order.use-case.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { PlaceOrderUseCase } from "../../src/orders/application/place-order.use-case.js";
import { InvalidOrderError } from "../../src/orders/domain/errors.js";
import { OrderId } from "../../src/orders/domain/order.js";
import { FakeUnitOfWork, FixedClock, SequentialIds } from "../support/fakes.js";
import { aPlaceOrderInput } from "./builders.js";

describe("PlaceOrderUseCase", () => {
  let uow: FakeUnitOfWork;
  let placeOrder: PlaceOrderUseCase;

  beforeEach(() => {
    uow = new FakeUnitOfWork();
    placeOrder = new PlaceOrderUseCase(uow, new SequentialIds(), new FixedClock());
  });

  it("places a pending order and returns its total", async () => {
    const output = await placeOrder.execute(aPlaceOrderInput());

    expect(output).toEqual({ orderId: "order-1", totalCents: 3000, currency: "USD" });
    expect((await uow.orders.get(OrderId("order-1")))?.status).toBe("pending");
    expect(uow.commits).toBe(1);
  });

  it("rejects an order without lines and stores nothing", async () => {
    await expect(placeOrder.execute(aPlaceOrderInput({ lines: [] }))).rejects.toThrow(InvalidOrderError);

    expect(uow.orders.rows.size).toBe(0);
    expect(uow.commits).toBe(0);
  });
});
```

## 5. Composition root

Small infrastructure adapters for the `IdGenerator` and `Clock` ports:

```typescript
// src/orders/adapters/outbound/system.ts
import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../../application/ports.js";

export class UuidIdGenerator implements IdGenerator {
  newId(): string {
    return randomUUID();
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
```

Each context exposes one function that turns infrastructure handles into ready-to-use use cases. It is the only module of the context that imports concrete adapters, and it knows nothing about the web framework:

```typescript
// src/orders/composition.ts
import type { PrismaClient } from "./adapters/outbound/prisma/client.js";
import { PrismaUnitOfWork } from "./adapters/outbound/prisma/unit-of-work.js";
import { SystemClock, UuidIdGenerator } from "./adapters/outbound/system.js";
import { PlaceOrderUseCase } from "./application/place-order.use-case.js";

export type OrdersModule = {
  readonly placeOrder: PlaceOrderUseCase;
};

/** The only module of the context that knows concrete adapters. Built once at startup. */
export const buildOrdersModule = (deps: { prisma: PrismaClient }): OrdersModule => {
  const uow = new PrismaUnitOfWork(deps.prisma);
  return { placeOrder: new PlaceOrderUseCase(uow, new UuidIdGenerator(), new SystemClock()) };
};
```

Configuration is validated once, at startup. Zod is used here only because `bootstrap/` is outside the core:

```typescript
// src/bootstrap/config.ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof schema>;

/** Validated once at startup; the process refuses to start with invalid configuration. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
```

The framework guides show `bootstrap/app.ts` (the HTTP app built from ready use cases) and `bootstrap/main.ts` (config, clients, composition, listen, graceful shutdown). NestJS replaces the composition function with modules; see `frameworks/nestjs.md`.

## 6. Errors

- Business failures are `DomainError` subclasses with a stable `code`; the three families of the shared kernel decide the HTTP status.
- Set `name` (the base class uses `new.target.name`) and keep the cause: `new ConflictError("...", { cause: error })`.
- Adapters translate technology errors (a unique violation, a vendor 402, a timeout) into these families or into an infrastructure error declared next to its port.
- Never throw strings or plain objects. Never send the message of an unexpected error to clients.
- A `Result<T, E>` type (for example `neverthrow`) is a valid alternative for expected failures. Pick one style per codebase; do not mix exceptions and results in the same use case.
- Handle `unhandledRejection` and `uncaughtException` by logging and exiting; let the orchestrator restart the process.

## 7. Pitfalls

- **ORM entities or Zod schemas as domain objects**: the API contract, validation and persistence become one type. Keep them in adapters and map.
- **Reading `process.env` outside `bootstrap/config.ts`**: configuration becomes invisible and untestable.
- **Floating promises** (a missing `await`) silently lose errors and break transactions. Lint for them.
- **Class instances in JSON responses**: getters and private fields do not serialize as expected. Return plain response objects.
- **`Date` is mutable**: copy dates you expose (`new Date(this.current)`) and keep them in UTC.
- **Barrel imports across layers and features** create cycles; import files directly and let dependency-cruiser catch cycles.
- **Singletons created at import time** (clients, pools): create them in `main.ts` or the framework's module system.

## 8. Architecture enforcement

dependency-cruiser fails CI when the dependency rule is broken:

```js
// .dependency-cruiser.cjs
/** Architecture rules: `npx depcruise src` fails the build when the dependency rule is broken. */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "The domain imports only the domain and the shared kernel.",
      severity: "error",
      from: { path: "^src/[^/]+/domain/" },
      to: { pathNot: ["^src/[^/]+/domain/", "^src/shared-kernel/"] },
    },
    {
      name: "application-depends-on-domain-only",
      comment: "Use cases never import adapters, frameworks or ORMs.",
      severity: "error",
      from: { path: "^src/[^/]+/application/" },
      to: {
        path: ["^src/[^/]+/adapters/", "^src/bootstrap/", "^node_modules/"],
        pathNot: ["^node_modules/@types/"],
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "inbound-does-not-import-outbound",
      comment: "Only the composition root knows concrete outbound adapters.",
      severity: "error",
      from: { path: "^src/[^/]+/adapters/inbound/" },
      to: { path: "^src/[^/]+/adapters/outbound/" },
    },
    {
      name: "outbound-does-not-import-inbound",
      severity: "error",
      from: { path: "^src/[^/]+/adapters/outbound/" },
      to: { path: "^src/[^/]+/adapters/inbound/" },
    },
    {
      name: "bounded-contexts-are-independent",
      severity: "error",
      from: { path: "^src/(orders|catalog)/" },
      to: { path: "^src/(orders|catalog)/", pathNot: "^src/$1/" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    parser: "swc", // needed with TypeScript 7, which has no JavaScript compiler API yet
    exclude: { path: "/generated/" },
  },
};
```

- Run `npx depcruise src --config .dependency-cruiser.cjs` in CI next to `tsc --noEmit`, the linter and the tests.
- **TypeScript 7 caveat**: dependency-cruiser parses TypeScript with the `typescript` package, whose programmatic API TypeScript 7 does not ship yet. Without a parser it reports "0 modules cruised" and passes while checking nothing. Install `@swc/core` and set `parser: "swc"` as above (or keep a TypeScript 6 install for tooling). Check the summary line says a non-zero number of modules.
- Prove the rules fire once: add a forbidden import on purpose (the domain importing `zod`) and confirm the command fails.
