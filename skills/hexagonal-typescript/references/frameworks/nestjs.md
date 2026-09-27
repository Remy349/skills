# NestJS adapter guide

Targets NestJS 12 (ES modules) on the Express platform; the same structure works on the Fastify platform. NestJS is an **inbound adapter plus a DI container**: controllers, pipes, guards and filters are adapters, and modules are the composition root. The domain and use cases are the ones from `../idioms.md`; nothing here adds Nest decorators to them.

## Contents
1. Detection
2. Where each Nest piece goes
3. Inbound adapter
4. Central error mapping
5. Composition root: modules and tokens
6. Transactions and request-scoped resources
7. Testing the adapter
8. Pitfalls

## 1. Detection

`@nestjs/core` in the dependencies; `*.module.ts`, `*.controller.ts`, `*.service.ts` files; `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig.json`. Check the major version: NestJS 12 ships as ES modules and requires Node 20+.

## 2. Where each Nest piece goes

| Nest piece | Hexagonal role | Rule |
|---|---|---|
| Controllers | Inbound adapter | Parse, call one use case, map the result. No rules, no repositories. |
| Pipes / request DTOs | Inbound adapter (edge validation) | Validate shape; map to the use case input type. |
| Exception filters | Central error mapping | One global filter maps error families to Problem Details. |
| Guards | Inbound adapter (authN/coarse authZ) | Resource-level permissions stay in the use case. |
| Interceptors | Decorators around the adapter | Logging, metrics, timeouts. |
| Modules and providers | Composition root | Bind port tokens to adapters; build use cases with factories. |
| `@Injectable()` services | Adapters, if anything | A "service" with business rules is a use case in disguise; move the rules inward. |

## 3. Inbound adapter

Interfaces do not exist at runtime, so ports and use cases are bound to `Symbol` tokens:

```typescript
// src/orders/adapters/inbound/http/tokens.ts
// Injection tokens. Interfaces do not exist at runtime, so ports and use cases are bound to symbols.
export const UNIT_OF_WORK = Symbol("UnitOfWork");
export const ID_GENERATOR = Symbol("IdGenerator");
export const CLOCK = Symbol("Clock");
export const PLACE_ORDER = Symbol("PlaceOrderUseCase");
```

The controller injects the use case by token and validates with the same framework-neutral Zod schema as the other adapters (`schemas.ts` in `express.md`, section 3):

```typescript
// src/orders/adapters/inbound/http/orders.controller.ts
import { Body, Controller, HttpCode, Inject, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import type { PlaceOrderOutput, PlaceOrderUseCase } from "../../../application/place-order.use-case.js";
import { placeOrderBody, toPlaceOrderInput } from "./schemas.js";
import { PLACE_ORDER } from "./tokens.js";

@Controller("orders")
export class OrdersController {
  constructor(@Inject(PLACE_ORDER) private readonly placeOrder: PlaceOrderUseCase) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<PlaceOrderOutput> {
    const output = await this.placeOrder.execute(toPlaceOrderInput(placeOrderBody.parse(body)));
    response.location(`/orders/${output.orderId}`);
    return output;
  }
}
```

With class-validator instead of Zod, keep the DTO classes in the adapter, enable `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, and still map the DTO to the use case input type explicitly.

## 4. Central error mapping

The framework-neutral translation (`problem-details.ts`) is shared with the other adapters; see `express.md`, section 4. One global filter catches everything:

```typescript
// src/orders/adapters/inbound/http/problem-details.filter.ts
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { INTERNAL_ERROR, type ProblemDetails, toProblem } from "./problem-details.js";

/** Catches everything: domain errors, validation errors, Nest's own HttpExceptions and bugs. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const problem = toProblem(error) ?? fromHttpException(error);
    if (problem === null) this.logger.error("unhandled error", error instanceof Error ? error.stack : error);
    const body = { ...(problem ?? INTERNAL_ERROR), instance: http.getRequest<Request>().originalUrl };
    http.getResponse<Response>().status(body.status).type("application/problem+json").json(body);
  }
}

const fromHttpException = (error: unknown): ProblemDetails | null =>
  error instanceof HttpException && error.getStatus() < 500
    ? { type: "about:blank", title: error.message, status: error.getStatus() }
    : null;
```

`@Catch()` with no arguments also receives Nest's own `HttpException`s (unknown route, payload too large); `fromHttpException` keeps their 4xx status. Never throw `HttpException` from use cases: that would make the application layer know HTTP.

## 5. Composition root: modules and tokens

The feature module builds use cases with `useFactory`, so the use case classes stay free of `@Injectable()` and can be constructed by hand in unit tests:

```typescript
// src/orders/adapters/inbound/http/orders.module.ts
import { Module } from "@nestjs/common";
import type { Clock, IdGenerator, UnitOfWork } from "../../../application/ports.js";
import { PlaceOrderUseCase } from "../../../application/place-order.use-case.js";
import { OrdersController } from "./orders.controller.js";
import { CLOCK, ID_GENERATOR, PLACE_ORDER, UNIT_OF_WORK } from "./tokens.js";

/**
 * Use cases stay free of Nest decorators: the module builds them with factories.
 * Port bindings (UNIT_OF_WORK, ID_GENERATOR, CLOCK) come from the infrastructure module or from tests.
 */
@Module({
  controllers: [OrdersController],
  providers: [
    {
      provide: PLACE_ORDER,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new PlaceOrderUseCase(uow, ids, clock),
    },
  ],
})
export class OrdersModule {}
```

Port bindings live in an infrastructure module at the context root: the only Nest module that imports concrete outbound adapters. Configuration arrives as an argument (`forRoot`), not from `process.env`:

```typescript
// src/orders/orders-infrastructure.module.ts
import { type DynamicModule, Module } from "@nestjs/common";
import { createPrismaClient, type PrismaClient } from "./adapters/outbound/prisma/client.js";
import { PrismaUnitOfWork } from "./adapters/outbound/prisma/unit-of-work.js";
import { SystemClock, UuidIdGenerator } from "./adapters/outbound/system.js";
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from "./adapters/inbound/http/tokens.js";

const PRISMA = Symbol("PrismaClient");

/** Composition root for production: binds ports to concrete adapters. Tests provide fakes instead. */
@Module({})
export class OrdersInfrastructureModule {
  static forRoot(config: { databaseUrl: string }): DynamicModule {
    return {
      module: OrdersInfrastructureModule,
      global: true,
      providers: [
        {
          provide: PRISMA,
          useFactory: () => {
            const prisma = createPrismaClient(config.databaseUrl);
            // Nest calls lifecycle hooks on factory-built providers too: close the pool on shutdown.
            return Object.assign(prisma, { onApplicationShutdown: () => prisma.$disconnect() });
          },
        },
        { provide: UNIT_OF_WORK, inject: [PRISMA], useFactory: (prisma: PrismaClient) => new PrismaUnitOfWork(prisma) },
        { provide: ID_GENERATOR, useValue: new UuidIdGenerator() },
        { provide: CLOCK, useValue: new SystemClock() },
      ],
      exports: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    };
  }
}
```

```typescript
// src/bootstrap/app.module.ts
import { type DynamicModule, Module } from "@nestjs/common";
import { OrdersInfrastructureModule } from "../orders/orders-infrastructure.module.js";
import { OrdersModule } from "../orders/adapters/inbound/http/orders.module.js";
import type { Config } from "./config.js";

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [OrdersInfrastructureModule.forRoot({ databaseUrl: config.DATABASE_URL }), OrdersModule],
    };
  }
}
```

```typescript
// src/bootstrap/main.ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ProblemDetailsFilter } from "../orders/adapters/inbound/http/problem-details.filter.js";
import { loadConfig } from "./config.js";
import { AppModule } from "./app.module.js";

const config = loadConfig();
const app = await NestFactory.create(AppModule.forRoot(config));
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableShutdownHooks(); // SIGTERM runs onApplicationShutdown hooks (closes the Prisma pool)
await app.listen(config.PORT);
```

Why factories instead of `@Injectable()` use cases: the application layer stays free of framework imports, the dependency-cruiser rules stay simple, and the same classes run under Express, Fastify, a CLI or a queue consumer. Adding `@Injectable()` to use cases is a known, small coupling; if a team accepts it, document it and keep decorators out of the domain regardless.

Nest calls lifecycle hooks (`onApplicationShutdown`) on factory-built providers too, which is how the infrastructure module closes the Prisma pool when `enableShutdownHooks()` receives `SIGTERM`.

## 6. Transactions and request-scoped resources

- The use case's unit of work owns the transaction. Avoid interceptors that open a transaction per request, and avoid request-scoped providers (`Scope.REQUEST`) for use cases: they rebuild the dependency graph on every request.
- Resolve the principal in a guard and pass it into the use case input from the controller.

## 7. Testing the adapter

The test module imports the real feature module and a test infrastructure module that binds the same tokens to fakes:

```typescript
// test/orders/http-adapter.test.ts
import "reflect-metadata";
import { Global, type INestApplication, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrdersModule } from "../../src/orders/adapters/inbound/http/orders.module.js";
import { ProblemDetailsFilter } from "../../src/orders/adapters/inbound/http/problem-details.filter.js";
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from "../../src/orders/adapters/inbound/http/tokens.js";
import { FakeUnitOfWork, FixedClock, SequentialIds } from "../support/fakes.js";

/** Test composition root: the same tokens bound to fakes. */
@Global()
@Module({
  providers: [
    { provide: UNIT_OF_WORK, useValue: new FakeUnitOfWork() },
    { provide: ID_GENERATOR, useValue: new SequentialIds("new") },
    { provide: CLOCK, useValue: new FixedClock() },
  ],
  exports: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
})
class FakeInfrastructureModule {}

describe("NestJS adapter", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FakeInfrastructureModule, OrdersModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(() => app.close());

  it("creates an order", async () => {
    const response = await request(app.getHttpServer())
      .post("/orders")
      .send({ customerId: "c-1", currency: "USD", lines: [{ sku: "A", quantity: 2, unitPriceCents: 150 }] });

    expect(response.status).toBe(201);
    expect(response.headers["location"]).toBe("/orders/new-1");
    expect(response.body).toEqual({ orderId: "new-1", totalCents: 300, currency: "USD" });
  });

  it("returns Problem Details with field errors for an invalid body", async () => {
    const response = await request(app.getHttpServer())
      .post("/orders")
      .send({ customerId: "c-1", currency: "usd", lines: [] });

    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body.errors.map((error: { field: string }) => error.field).sort()).toEqual(["currency", "lines"]);
  });

  it("maps unknown routes to a 404 Problem Details", async () => {
    const response = await request(app.getHttpServer()).get("/nope");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });
});
```

Explicit `@Inject(TOKEN)` everywhere means the tests do not depend on decorator metadata, so they run under Vitest's transformer as well as under `tsc`.

## 8. Pitfalls

- **`@Entity()`-decorated ORM classes used as domain objects** and returned from controllers: keep them in the persistence adapter and map.
- **A `*Service` per entity holding every operation**: split into use cases; keep services for adapter plumbing only.
- **Repositories injected into controllers**: controllers call use cases, never repositories.
- **`HttpException` thrown from domain or application code**: throw domain errors; the filter maps them.
- **Circular module imports solved with `forwardRef`**: usually a sign that two bounded contexts depend on each other's internals. Depend on the other context's use case contract or integration events instead.
- **Relying on `emitDecoratorMetadata` for interface-typed constructor parameters**: interfaces erase to `Object`; always use `@Inject(TOKEN)` for ports.
