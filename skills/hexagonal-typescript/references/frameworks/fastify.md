# Fastify adapter guide

Targets Fastify 5. Fastify is an **inbound adapter**; `bootstrap/` is the composition root. The domain and use cases are the ones from `../idioms.md`; nothing here changes them.

## Contents
1. Detection
2. Where each Fastify piece goes
3. Inbound adapter
4. Central error mapping
5. Composition root
6. Transactions and request-scoped resources
7. Testing the adapter
8. Pitfalls

## 1. Detection

`fastify` in the dependencies without `@nestjs/core` (NestJS can run on Fastify; then follow `nestjs.md`). Common companions: `@fastify/type-provider-*` for schema-typed routes, `@fastify/helmet`, `@fastify/cors`.

## 2. Where each Fastify piece goes

| Fastify piece | Hexagonal role | Rule |
|---|---|---|
| Routes inside a plugin | Inbound adapter | Parse, call one use case, map the result. No rules, no SQL. |
| Request schemas (Zod, or JSON Schema) | Inbound adapter DTOs | Validate shape; map to the use case input type. |
| `setErrorHandler` | Central error mapping | Maps error families to Problem Details. |
| `app.decorate` / `decorateRequest` | Adapter plumbing only | Never a service locator for use cases. |
| `createApp(useCases)` | App factory | Registers plugins built from ready use cases. |
| Hooks (`onRequest`, `onClose`) | Edge concerns and lifecycle | Auth, correlation ids, closing pools. |

## 3. Inbound adapter

Request schemas are framework-neutral (`schemas.ts` is the same file as in `express.md`, section 3). Routes are a plugin created from the use cases:

```typescript
// src/orders/adapters/inbound/http/orders.routes.ts
import type { FastifyPluginAsync } from "fastify";
import type { PlaceOrderUseCase } from "../../../application/place-order.use-case.js";
import { placeOrderBody, toPlaceOrderInput } from "./schemas.js";

/** A Fastify plugin that receives its use cases: no decorators on the instance, no global lookups. */
export const ordersRoutes =
  (useCases: { placeOrder: PlaceOrderUseCase }): FastifyPluginAsync =>
  async (app) => {
    app.post("/orders", async (request, reply) => {
      const body = placeOrderBody.parse(request.body);
      const output = await useCases.placeOrder.execute(toPlaceOrderInput(body));
      return reply.code(201).header("location", `/orders/${output.orderId}`).send(output);
    });
  };
```

Passing use cases into the plugin factory keeps routes explicit and testable. Avoid `app.decorate("placeOrder", ...)` followed by `app.placeOrder` inside routes: it turns the instance into a service locator and hides dependencies.

Fastify's native JSON Schema validation (or a Zod type provider) is a fine alternative to parsing in the handler; either way, the validated body is mapped to the use case input type and never passed through as is.

## 4. Central error mapping

The framework-neutral translation (`problem-details.ts`) is shared with the other adapters; see `express.md`, section 4. The Fastify handler:

```typescript
// src/orders/adapters/inbound/http/error-handler.ts
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { INTERNAL_ERROR, type ProblemDetails, toProblem } from "./problem-details.js";

/** Errors raised by Fastify itself (malformed JSON, body too large) carry a 4xx `statusCode`. */
const frameworkClientError = (error: FastifyError): ProblemDetails | null => {
  const status = error.statusCode;
  if (status === undefined || status < 400 || status >= 500) return null;
  return { type: "about:blank", title: error.message, status };
};

export const errorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  const problem = toProblem(error) ?? frameworkClientError(error);
  if (problem === null) request.log.error({ err: error }, "unhandled error"); // log once, here
  const body = { ...(problem ?? INTERNAL_ERROR), instance: request.url };
  return reply.code(body.status).type("application/problem+json").send(body);
};
```

Fastify's own client errors (malformed JSON, body over `bodyLimit`) carry a 4xx `statusCode`; the handler keeps them as 4xx instead of turning them into 500s.

## 5. Composition root

```typescript
// src/bootstrap/app.ts
import Fastify, { type FastifyInstance } from "fastify";
import { errorHandler } from "../orders/adapters/inbound/http/error-handler.js";
import { ordersRoutes } from "../orders/adapters/inbound/http/orders.routes.js";
import type { PlaceOrderUseCase } from "../orders/application/place-order.use-case.js";

/** Builds the HTTP app from ready use cases, so tests can pass use cases wired to fakes. */
export const createApp = async (
  useCases: { placeOrder: PlaceOrderUseCase },
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 100 * 1024 });
  app.setErrorHandler(errorHandler);
  await app.register(ordersRoutes(useCases));
  return app;
};
```

```typescript
// src/bootstrap/main.ts
import { createPrismaClient } from "../orders/adapters/outbound/prisma/client.js";
import { buildOrdersModule } from "../orders/composition.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const app = await createApp(buildOrdersModule({ prisma }));

app.addHook("onClose", async () => prisma.$disconnect()); // graceful shutdown closes the pool
process.once("SIGTERM", () => void app.close());
await app.listen({ port: config.PORT, host: "0.0.0.0" });
```

`buildOrdersModule` is the composition function from `../idioms.md`, section 5. The `onClose` hook plus `app.close()` on `SIGTERM` stops accepting requests, waits for in-flight ones and closes the pool.

## 6. Transactions and request-scoped resources

- The use case's unit of work owns the transaction; do not begin one in `onRequest` and commit in `onResponse`.
- Resolve request-scoped data (principal, tenant) in a hook and pass it into the use case input as plain values.

## 7. Testing the adapter

`app.inject()` runs the full request lifecycle in memory, without opening a port:

```typescript
// test/orders/http-adapter.test.ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/bootstrap/app.js";
import { PlaceOrderUseCase } from "../../src/orders/application/place-order.use-case.js";
import { FakeUnitOfWork, FixedClock, SequentialIds } from "../support/fakes.js";

const app = () =>
  createApp({
    placeOrder: new PlaceOrderUseCase(new FakeUnitOfWork(), new SequentialIds("new"), new FixedClock()),
  });

describe("Fastify adapter", () => {
  it("creates an order", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/orders",
      payload: { customerId: "c-1", currency: "USD", lines: [{ sku: "A", quantity: 2, unitPriceCents: 150 }] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["location"]).toBe("/orders/new-1");
    expect(response.json()).toEqual({ orderId: "new-1", totalCents: 300, currency: "USD" });
  });

  it("returns Problem Details with field errors for an invalid body", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/orders",
      payload: { customerId: "c-1", currency: "usd", lines: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(
      response
        .json()
        .errors.map((error: { field: string }) => error.field)
        .sort(),
    ).toEqual(["currency", "lines"]);
  });

  it("returns 400, not 500, for malformed JSON", async () => {
    const response = await (
      await app()
    ).inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
  });
});
```

Add one test per mapped error family as routes appear (404, 409, 422 and a generic 500).

## 8. Pitfalls

- **Use cases registered with `decorate` and pulled from `this`/`app` inside handlers**: hidden dependencies; pass them to the plugin factory.
- **Plugin encapsulation surprises**: an error handler set inside an encapsulated plugin does not apply to its siblings. Register the central handler on the root instance before the route plugins.
- **Returning domain objects from handlers**: Fastify serializes own enumerable properties; getters and private fields do not appear. Return the use case output.
- **Business rules in hooks or `preHandler`**: rules belong in the use case.
