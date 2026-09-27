# Express adapter guide

Targets Express 5. Express is an **inbound adapter**; `bootstrap/` is the composition root. The domain and use cases are the ones from `../idioms.md`; nothing here changes them.

## Contents
1. Detection
2. Where each Express piece goes
3. Inbound adapter
4. Central error mapping
5. Composition root
6. Transactions and request-scoped resources
7. Testing the adapter
8. Pitfalls

## 1. Detection

`express` in the dependencies without `@nestjs/core`. Check the major version: Express 5 forwards rejected promises from async handlers to the error middleware; Express 4 does not (there you need a wrapper such as `express-async-errors` or explicit `next(error)`).

## 2. Where each Express piece goes

| Express piece | Hexagonal role | Rule |
|---|---|---|
| `Router` and handlers | Inbound adapter | Parse, call one use case, map the result. No rules, no SQL. |
| Zod (or other) request schemas | Inbound adapter DTOs | Validate shape; map to the use case input type. |
| Error middleware `(err, req, res, next)` | Central error mapping | Registered last; maps error families to Problem Details. |
| `createApp(useCases)` | App factory | Builds middleware and routes from ready use cases. |
| `main.ts` | Composition root | Config, clients, `buildOrdersModule`, `listen`, graceful shutdown. |
| `req`, `res`, `res.locals` | Adapter-only context | Never passed into use cases. |

## 3. Inbound adapter

Request schemas and the problem-details translation are shared by every HTTP framework, so they live next to the routes and contain no Express code:

```typescript
// src/orders/adapters/inbound/http/schemas.ts
import { z } from "zod";
import type { PlaceOrderInput } from "../../../application/place-order.use-case.js";

// Request shapes shared by every HTTP framework adapter. Unknown fields are rejected (no mass assignment).
export const placeOrderBody = z.strictObject({
  customerId: z.string().min(1).max(64),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z
    .array(
      z.strictObject({
        sku: z.string().min(1).max(64),
        quantity: z.number().int().positive().max(1000),
        unitPriceCents: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(100),
});

export const toPlaceOrderInput = (body: z.infer<typeof placeOrderBody>): PlaceOrderInput => ({
  customerId: body.customerId,
  currency: body.currency,
  lines: body.lines,
});
```

Shape validation happens here. Business rules ("lines in one currency") stay in the domain even when a schema constraint happens to overlap.

The router is created by a factory that **receives the use cases**; it never imports the composition module or an outbound adapter:

```typescript
// src/orders/adapters/inbound/http/orders.router.ts
import { Router } from "express";
import type { PlaceOrderUseCase } from "../../../application/place-order.use-case.js";
import { placeOrderBody, toPlaceOrderInput } from "./schemas.js";

/** Use cases are passed in by the composition root: no globals, no imports of outbound adapters. */
export const ordersRouter = (useCases: { placeOrder: PlaceOrderUseCase }): Router => {
  const router = Router();

  // Express 5 forwards rejected promises to the error middleware: no try/catch per route.
  router.post("/orders", async (req, res) => {
    const body = placeOrderBody.parse(req.body);
    const output = await useCases.placeOrder.execute(toPlaceOrderInput(body));
    res.status(201).location(`/orders/${output.orderId}`).json(output);
  });

  return router;
};
```

Recipes add routes with the same shape: `POST /orders/:orderId/cancellation` reads `If-Match`, `GET /orders` reads `limit` and `cursor` from `req.query`, and `POST /orders` accepts an `Idempotency-Key` header.

Take identity from authentication middleware (`res.locals.principal` set after verifying a token), never from the body, and pass it into the use case input.

## 4. Central error mapping

One framework-neutral translation of error families:

```typescript
// src/orders/adapters/inbound/http/problem-details.ts
import { ZodError } from "zod";
import { ConflictError, DomainError, NotFoundError } from "../../../../shared-kernel/errors.js";

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  code?: string;
  errors?: { field: string; message: string }[];
};

/** Map error families, not individual errors: a new domain error needs no change here. */
export const statusFor = (error: DomainError): number => {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  return 422; // any other business rule violation
};

/** One translation for every framework adapter. Returns null for unexpected errors (log them, answer 500). */
export const toProblem = (error: unknown): ProblemDetails | null => {
  if (error instanceof ZodError) {
    return {
      type: "about:blank",
      title: "Request validation failed",
      status: 400,
      code: "VALIDATION_FAILED",
      errors: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    };
  }
  if (error instanceof DomainError) {
    return { type: "about:blank", title: error.message, status: statusFor(error), code: error.code };
  }
  return null;
};

export const INTERNAL_ERROR: ProblemDetails = { type: "about:blank", title: "Internal Server Error", status: 500 };
```

And one Express error middleware that uses it:

```typescript
// src/orders/adapters/inbound/http/error-handler.ts
import type { ErrorRequestHandler } from "express";
import { INTERNAL_ERROR, type ProblemDetails, toProblem } from "./problem-details.js";

/** Errors raised by Express itself (malformed JSON, body too large) carry a 4xx `status`. */
const frameworkClientError = (error: unknown): ProblemDetails | null => {
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number" || status < 400 || status >= 500) return null;
  return { type: "about:blank", title: (error as Error).message, status };
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const problem = toProblem(error) ?? frameworkClientError(error);
  if (problem === null) console.error("unhandled error", error); // log once, here; use your structured logger
  const body = { ...(problem ?? INTERNAL_ERROR), instance: req.originalUrl };
  res.status(body.status).type("application/problem+json").json(body);
};
```

Without the `status` check, a malformed JSON body (which Express rejects with a 400 `SyntaxError`) would become a 500.

## 5. Composition root

The app factory builds the HTTP app from ready use cases, so tests can pass use cases wired to fakes:

```typescript
// src/bootstrap/app.ts
import express, { type Express } from "express";
import { errorHandler } from "../orders/adapters/inbound/http/error-handler.js";
import { ordersRouter } from "../orders/adapters/inbound/http/orders.router.js";
import type { PlaceOrderUseCase } from "../orders/application/place-order.use-case.js";

/** Builds the HTTP app from ready use cases, so tests can pass use cases wired to fakes. */
export const createApp = (useCases: { placeOrder: PlaceOrderUseCase }): Express => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(ordersRouter(useCases));
  app.use(errorHandler); // registered last
  return app;
};
```

`main.ts` is the only place that reads configuration, creates clients and calls the composition function from `../idioms.md`, section 5:

```typescript
// src/bootstrap/main.ts
import { createPrismaClient } from "../orders/adapters/outbound/prisma/client.js";
import { buildOrdersModule } from "../orders/composition.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const orders = buildOrdersModule({ prisma });

const server = createApp(orders).listen(config.PORT);

// Graceful shutdown: stop accepting connections, finish in-flight requests, close the pool.
process.once("SIGTERM", () => {
  server.close(() => void prisma.$disconnect());
});
```

Use cases are built once and shared across requests: they hold no request state, and each call opens its own unit of work.

## 6. Transactions and request-scoped resources

- The use case's unit of work owns the transaction. Do not open a transaction in a middleware and commit it in `res.on("finish")`: the route would become the transaction boundary.
- Do not stash database clients or transactions on `req`. Resolve request-scoped data (principal, tenant, correlation id) in middleware and pass it as plain values.

## 7. Testing the adapter

`supertest` drives the real app built with fakes: no port is opened, no database is touched.

```typescript
// test/orders/http-adapter.test.ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap/app.js";
import { PlaceOrderUseCase } from "../../src/orders/application/place-order.use-case.js";
import { FakeUnitOfWork, FixedClock, SequentialIds } from "../support/fakes.js";

const app = () =>
  createApp({
    placeOrder: new PlaceOrderUseCase(new FakeUnitOfWork(), new SequentialIds("new"), new FixedClock()),
  });

describe("Express adapter", () => {
  it("creates an order", async () => {
    const response = await request(app())
      .post("/orders")
      .send({ customerId: "c-1", currency: "USD", lines: [{ sku: "A", quantity: 2, unitPriceCents: 150 }] });

    expect(response.status).toBe(201);
    expect(response.headers["location"]).toBe("/orders/new-1");
    expect(response.body).toEqual({ orderId: "new-1", totalCents: 300, currency: "USD" });
  });

  it("returns Problem Details with field errors for an invalid body", async () => {
    const response = await request(app()).post("/orders").send({ customerId: "c-1", currency: "usd", lines: [] });

    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body.errors.map((error: { field: string }) => error.field).sort()).toEqual(["currency", "lines"]);
  });

  it("returns 400, not 500, for malformed JSON", async () => {
    const response = await request(app()).post("/orders").set("content-type", "application/json").send("{");

    expect(response.status).toBe(400);
  });
});
```

Add one test per mapped error family as routes appear (404, 409, 422 and a generic 500).

## 8. Pitfalls

- **Business rules in middleware** (`checkStock` before the handler): rules belong in the use case.
- **`try/catch` in every handler** building ad-hoc error JSON: throw, and let the error middleware map it once.
- **Returning ORM entities or domain objects with `res.json(entity)`**: getters and private state do not serialize as expected and the contract couples to the schema. Return the use case output or an explicit response object.
- **Express 4 async handlers** without a wrapper: rejections never reach the error middleware and requests hang.
- **Module-level `app`** with routes wired to singletons: tests cannot swap dependencies. Use the factory.
