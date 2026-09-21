# TypeScript (Node.js) reference

Applies to Express, Fastify, Hono and NestJS backends. Read the parts for your framework; the core rules do not change.

## Contents
1. Detection and tooling
2. Naming and style conventions
3. Layout
4. Vertical slice example (PlaceOrder)
5. Express/Fastify wiring
6. NestJS specifics
7. Errors
8. Persistence adapters
9. Testing
10. Pitfalls
11. Architecture enforcement

## 1. Detection and tooling

- Confirm `strict` is enabled in `tsconfig.json`. Recommended flags: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true`, `"verbatimModuleSyntax": true` (use `import type`). Do not introduce `any`; use `unknown` at boundaries and narrow.
- Detect the formatter/linter already present: Prettier + ESLint (`typescript-eslint`) or Biome. Keep them. Enable `@typescript-eslint/no-floating-promises` and `no-misused-promises`.
- Package manager: follow the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`). Module system: follow the project (ESM preferred for new code).
- Test runner: Vitest or Jest (whatever is present); `supertest` for HTTP; Testcontainers for Node for infrastructure.

## 2. Naming and style conventions

- Files: `kebab-case` (`place-order.use-case.ts`, `order.repository.ts`, `postgres-order.repository.ts`); keep the project's suffix scheme (NestJS uses `.controller.ts`, `.service.ts`, `.module.ts`).
- Types, interfaces, classes, enums, type aliases: `PascalCase`. **No `I` prefix** on interfaces in TypeScript (`OrderRepository`, not `IOrderRepository`); adapters are named after the technology (`PostgresOrderRepository`).
- Variables, functions, methods, properties: `camelCase`. Constants: `UPPER_SNAKE_CASE` for true module-level constants, otherwise `camelCase`. Booleans: `isPaid`, `hasStock`.
- Prefer string-literal unions (`type OrderStatus = "pending" | "paid"`) over `enum`. Use `readonly` and `as const`. Prefer `type` for unions and aliases, `interface` for object contracts you expect to be implemented.
- Prefer named exports over default exports. Avoid barrel files (`index.ts`) that re-export whole layers; they create cycles and hide dependency direction.
- Use `unknown` in `catch` blocks and narrow with `instanceof`. Use `async/await`, never floating promises.
- Money: integer minor units (`amountCents: number`) or a decimal library; never floats. IDs: branded types (`type OrderId = string & { readonly __brand: "OrderId" }`) where mixing ids is a real risk.

## 3. Layout

```
src/
  features/orders/
    domain/
      order.ts
      order.errors.ts
    application/
      ports/
        order.repository.ts        # outbound ports (interfaces)
        payment.gateway.ts
        id-generator.ts
      place-order.use-case.ts      # use case + its input/output types
    adapters/
      inbound/http/
        orders.routes.ts           # or orders.controller.ts for Nest
        orders.dto.ts              # Zod schemas / DTO classes
      outbound/
        postgres/postgres-order.repository.ts
        payments/stripe-payment.gateway.ts
    composition/orders.container.ts  # or orders.module.ts for Nest
  shared/                            # tiny pure helpers only
  bootstrap/
    main.ts  config.ts  error-handler.ts  server.ts
```

## 4. Vertical slice example (PlaceOrder)

Domain, no imports:

```ts
// domain/order.errors.ts
export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class InvalidOrderError extends DomainError {
  readonly code = "ORDER_INVALID";
}
export class OrderNotFoundError extends DomainError {
  readonly code = "ORDER_NOT_FOUND";
}
```

```ts
// domain/order.ts
import { InvalidOrderError } from "./order.errors";

export type OrderStatus = "pending" | "authorized";

export class Order {
  private constructor(
    readonly id: string,
    readonly amountCents: number,
    readonly status: OrderStatus,
    readonly authorizationId: string | null,
  ) {}

  static create(props: { id: string; amountCents: number }): Order {
    if (!Number.isInteger(props.amountCents) || props.amountCents <= 0) {
      throw new InvalidOrderError("amountCents must be a positive integer");
    }
    return new Order(props.id, props.amountCents, "pending", null);
  }

  static rehydrate(props: {
    id: string;
    amountCents: number;
    status: OrderStatus;
    authorizationId: string | null;
  }): Order {
    return new Order(props.id, props.amountCents, props.status, props.authorizationId);
  }

  markAuthorized(authorizationId: string): Order {
    return new Order(this.id, this.amountCents, "authorized", authorizationId);
  }
}
```

Ports and use case (application layer):

```ts
// application/ports/order.repository.ts
import type { Order } from "../../domain/order";

export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}

// application/ports/payment.gateway.ts
export interface PaymentGateway {
  authorize(input: { orderId: string; amountCents: number }): Promise<{ authorizationId: string }>;
}

// application/ports/id-generator.ts
export interface IdGenerator {
  next(): string;
}
```

```ts
// application/place-order.use-case.ts
import { Order } from "../domain/order";
import type { IdGenerator } from "./ports/id-generator";
import type { OrderRepository } from "./ports/order.repository";
import type { PaymentGateway } from "./ports/payment.gateway";

export type PlaceOrderInput = { amountCents: number };
export type PlaceOrderOutput = { orderId: string; authorizationId: string };

export class PlaceOrderUseCase {
  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentGateway,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: PlaceOrderInput): Promise<PlaceOrderOutput> {
    const order = Order.create({ id: this.ids.next(), amountCents: input.amountCents });
    const { authorizationId } = await this.payments.authorize({
      orderId: order.id,
      amountCents: order.amountCents,
    });
    await this.orders.save(order.markAuthorized(authorizationId));
    return { orderId: order.id, authorizationId };
  }
}
```

## 5. Express/Fastify wiring

Validate with Zod (or Valibot/TypeBox) in the inbound adapter; never in the use case:

```ts
// adapters/inbound/http/orders.routes.ts  (Express 5 forwards rejected promises to error middleware)
import { Router } from "express";
import { z } from "zod";
import type { PlaceOrderUseCase } from "../../../application/place-order.use-case";

const placeOrderBody = z.object({ amountCents: z.number().int().positive() }).strict();

export const ordersRouter = (deps: { placeOrder: PlaceOrderUseCase }): Router => {
  const router = Router();
  router.post("/orders", async (req, res) => {
    const body = placeOrderBody.parse(req.body); // ZodError -> 400 in error middleware
    const out = await deps.placeOrder.execute(body);
    res.status(201).location(`/orders/${out.orderId}`).json(out);
  });
  return router;
};
```

Central error mapping (one place, Problem Details):

```ts
// bootstrap/error-handler.ts
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { InvalidOrderError, OrderNotFoundError } from "../features/orders/domain/order.errors";

const statusByError = new Map<Function, number>([
  [InvalidOrderError, 422],
  [OrderNotFoundError, 404],
]);

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  res.type("application/problem+json");
  if (err instanceof ZodError) {
    return res.status(400).json({
      title: "Request validation failed",
      status: 400,
      errors: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
    });
  }
  const status = [...statusByError].find(([type]) => err instanceof type)?.[1];
  if (status) {
    return res.status(status).json({ title: err.message, status, code: err.code, instance: req.originalUrl });
  }
  req.log?.error({ err }, "unhandled error"); // log once, here
  return res.status(500).json({ title: "Internal Server Error", status: 500 });
};
```

Composition root (explicit, no container needed):

```ts
// composition/orders.container.ts
export const buildOrders = (deps: { db: SqlClient; stripe: StripeClient }) => {
  const orders = new PostgresOrderRepository(deps.db);
  const payments = new StripePaymentGateway(deps.stripe);
  const placeOrder = new PlaceOrderUseCase(orders, payments, { next: () => crypto.randomUUID() });
  return { placeOrder };
};
```

`bootstrap/main.ts` loads and validates config (Zod schema over `process.env`), builds infrastructure, calls the `build*` functions, mounts routers, registers `errorHandler` last, and handles `SIGTERM` by closing the server and pools.

## 6. NestJS specifics

Nest's module system is the composition root. Keep the same dependency rule.

- **Interfaces do not exist at runtime**, so a port cannot be an injection token by itself. Use either an `abstract class OrderRepository` (acts as token and contract) or a `Symbol`/string token with `@Inject(ORDER_REPOSITORY)`. Prefer one approach across the project.
- Keep **domain code free of decorators**. For the application layer, either (a) accept `@Injectable()` on use cases as a conscious, small coupling, or (b) keep use cases decorator-free and register them with `useFactory` in the module. Choose (b) when strict purity matters.
- Modules: one per feature. Bind ports to adapters in `providers`: `{ provide: OrderRepository, useClass: PostgresOrderRepository }`. Export only the use cases other modules need.
- Controllers are inbound adapters: DTO classes with `class-validator`/`class-transformer` (`ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`) or Zod pipes. Controllers call the use case and return a response DTO, never the entity.
- Errors: `@Catch(DomainError)` exception filters map to Problem Details; register globally in `main.ts` or via `APP_FILTER`. Do not throw `HttpException` from the domain or application layers.
- Guards for authentication/authorization, interceptors for logging/metrics/transactions (Decorator pattern), pipes for validation.
- ORMs (TypeORM, MikroORM, Prisma): decorated entity classes are **persistence models** in the adapter. Map to domain objects in the repository. Do not decorate domain classes with `@Entity`.
- Testing: `Test.createTestingModule({...}).overrideProvider(OrderRepository).useValue(new InMemoryOrderRepository())`; use `supertest` against the Nest app for inbound tests.

## 7. Errors

- Domain/application errors extend a base `DomainError` (or `AppError`) with a stable `code`. Use `instanceof` to map. Set `this.name` and preserve the `cause`: `new InfraError("...", { cause: err })`.
- Optionally use a `Result<T, E>` type (e.g. `neverthrow`) for expected failures; be consistent, do not mix styles in one use case.
- Never throw strings or plain objects. Never send `err.message` of unknown errors to clients.
- Handle `unhandledRejection` and `uncaughtException` by logging and exiting; let the orchestrator restart.

## 8. Persistence adapters

- Prisma/Drizzle/Kysely/TypeORM types stay inside `adapters/outbound/postgres`. Return domain objects through `Order.rehydrate(...)`. Do not return ORM rows from repositories.
- Transactions: expose a `UnitOfWork` port (`run<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>`) or use a decorator; the SQL client's `transaction()` is used only in the adapter.
- Map unique-constraint violations to a domain/application `ConflictError`.

## 9. Testing

- Domain and use case tests with Vitest/Jest and in-memory fakes (`InMemoryOrderRepository implements OrderRepository`).
- Name tests by behavior: `it("rejects a non-positive amount")`; use `it.each` for tables.
- Inbound tests with `supertest` (`request(app).post("/orders").send({...}).expect(201)`), injecting a fake use case or fakes for the ports.
- Integration tests with `@testcontainers/postgresql`, applying real migrations.
- Use `vi.useFakeTimers()` / injected clock, never real sleeps.
- Coverage with the runner's built-in reporter; add Stryker for critical rules if desired.

## 10. Pitfalls

- Class instances lose methods when serialized to JSON; return plain response DTOs.
- `Date` is mutable and timezone-sensitive: keep UTC, inject a clock.
- Avoid deep barrel imports and circular imports between features; depend on other features only through their published use case contracts.
- `async` functions in event emitters/callbacks can swallow errors; handle explicitly.
- Do not read `process.env` outside `config.ts`.
- Do not mutate objects received from callers; do not share mutable singletons between requests.

## 11. Architecture enforcement

`dependency-cruiser` rule sketch (`.dependency-cruiser.cjs`):

```js
forbidden: [
  { name: "domain-is-pure", severity: "error",
    from: { path: "^src/features/[^/]+/domain" },
    to:   { path: "^src/features/[^/]+/(application|adapters)|^node_modules/(express|fastify|@nestjs|zod|pg|prisma)" } },
  { name: "application-no-adapters", severity: "error",
    from: { path: "^src/features/[^/]+/application" },
    to:   { path: "^src/features/[^/]+/adapters" } },
  { name: "no-cross-adapter", severity: "error",
    from: { path: "adapters/inbound" }, to: { path: "adapters/outbound" } },
]
```

Run it in CI (`depcruise src`), next to `tsc --noEmit`, the linter and the tests.
