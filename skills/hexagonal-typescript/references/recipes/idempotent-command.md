# Recipe: idempotent command with an Idempotency-Key

## Problem

A client posts an order, the connection drops before the response arrives, and the client retries. Without protection the retry creates a second order (or a second charge). `POST` is not idempotent by definition, so the API must make it so.

## Use it when / skip it when

- Use when: a command creates something or has an external effect (orders, payments, emails), and clients or gateways retry.
- Skip when: the operation is naturally idempotent (`PUT` with the full resource, `DELETE`, a state transition guarded by the aggregate such as "cancel a pending order").

## Design

- **The client sends `Idempotency-Key`** (a UUID it generates per logical operation) on the `POST`.
- **A decorator wraps the use case** and exposes the same `execute` plus an optional key. The wrapped `PlaceOrderUseCase` stays unaware of idempotency (Open/Closed).
- **Reserve, execute, complete.** The store atomically reserves `(scope, key)` with a fingerprint of the request. The first request executes and stores the response; a retry with the same key and payload gets the stored response; the same key with a different payload is rejected; a retry while the first is still running gets a conflict.
- **Failures release the key** so the client can retry a command that failed.
- **Scope** separates keys per command (`place-order`), so one key cannot collide across endpoints.

## Code

```typescript
// src/orders/application/idempotency.ts
import { createHash } from "node:crypto";
import { ConflictError, DomainError } from "../../shared-kernel/errors.js";
import type { PlaceOrderInput, PlaceOrderOutput, PlaceOrderUseCase } from "./place-order.use-case.js";

export class IdempotencyKeyReusedError extends DomainError {
  override readonly code = "IDEMPOTENCY_KEY_REUSED";
}

export type IdempotencyRecord = {
  readonly fingerprint: string;
  /** null while the first request is still running */
  readonly response: PlaceOrderOutput | null;
};

export interface IdempotencyStore {
  /** Atomically claim the key. Resolves null if claimed now, or the existing record if it was already claimed. */
  reserve(input: { scope: string; key: string; fingerprint: string }): Promise<IdempotencyRecord | null>;
  complete(input: { scope: string; key: string; response: PlaceOrderOutput }): Promise<void>;
  /** Forget a claim whose command failed, so the client can retry. */
  release(input: { scope: string; key: string }): Promise<void>;
}

/** Stable hash of the use case input: key order and formatting of the HTTP body do not matter. */
export const fingerprint = (input: PlaceOrderInput): string => {
  const canonical = JSON.stringify({
    customerId: input.customerId,
    currency: input.currency,
    lines: input.lines.map((line) => [line.sku, line.quantity, line.unitPriceCents]),
  });
  return createHash("sha256").update(canonical).digest("hex");
};

/** Decorator: same contract as PlaceOrderUseCase, replays the stored result for a repeated key. */
export class IdempotentPlaceOrder {
  static readonly SCOPE = "place-order";

  constructor(
    private readonly inner: PlaceOrderUseCase,
    private readonly store: IdempotencyStore,
  ) {}

  async execute(input: PlaceOrderInput, idempotencyKey?: string): Promise<PlaceOrderOutput> {
    if (idempotencyKey === undefined) return this.inner.execute(input);

    const scope = IdempotentPlaceOrder.SCOPE;
    const requestFingerprint = fingerprint(input);
    const existing = await this.store.reserve({ scope, key: idempotencyKey, fingerprint: requestFingerprint });
    if (existing !== null) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new IdempotencyKeyReusedError("idempotency key was already used with a different request");
      }
      if (existing.response === null) {
        throw new ConflictError("a request with this idempotency key is still in progress");
      }
      return existing.response;
    }

    let output: PlaceOrderOutput;
    try {
      output = await this.inner.execute(input);
    } catch (error) {
      await this.store.release({ scope, key: idempotencyKey });
      throw error;
    }
    await this.store.complete({ scope, key: idempotencyKey, response: output });
    return output;
  }
}
```

The fingerprint hashes a canonical form of the use case input, not the raw HTTP body, so key order and whitespace do not count as a different request.

## Tests

Fake store, added to the shared fakes:

```ts
// test/support/fakes.ts  (addition)
import type { IdempotencyRecord, IdempotencyStore } from "../../src/orders/application/idempotency.js";
import type { PlaceOrderOutput } from "../../src/orders/application/place-order.use-case.js";

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly records = new Map<string, IdempotencyRecord>();

  async reserve(input: { scope: string; key: string; fingerprint: string }): Promise<IdempotencyRecord | null> {
    const id = `${input.scope}:${input.key}`;
    const existing = this.records.get(id) ?? null;
    if (existing === null) this.records.set(id, { fingerprint: input.fingerprint, response: null });
    return existing;
  }

  async complete(input: { scope: string; key: string; response: PlaceOrderOutput }): Promise<void> {
    const id = `${input.scope}:${input.key}`;
    const record = this.records.get(id);
    if (record) this.records.set(id, { ...record, response: input.response });
  }

  async release(input: { scope: string; key: string }): Promise<void> {
    this.records.delete(`${input.scope}:${input.key}`);
  }
}
```

```typescript
// test/orders/idempotency.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  IdempotencyKeyReusedError,
  IdempotentPlaceOrder,
  fingerprint,
} from "../../src/orders/application/idempotency.js";
import { PlaceOrderUseCase } from "../../src/orders/application/place-order.use-case.js";
import { InvalidOrderError } from "../../src/orders/domain/errors.js";
import { ConflictError } from "../../src/shared-kernel/errors.js";
import { FakeUnitOfWork, FixedClock, InMemoryIdempotencyStore, SequentialIds } from "../support/fakes.js";
import { aPlaceOrderInput } from "./builders.js";

describe("IdempotentPlaceOrder", () => {
  let uow: FakeUnitOfWork;
  let store: InMemoryIdempotencyStore;
  let placeOrder: IdempotentPlaceOrder;

  beforeEach(() => {
    uow = new FakeUnitOfWork();
    store = new InMemoryIdempotencyStore();
    placeOrder = new IdempotentPlaceOrder(new PlaceOrderUseCase(uow, new SequentialIds(), new FixedClock()), store);
  });

  it("replays the first result for a retry with the same key", async () => {
    const first = await placeOrder.execute(aPlaceOrderInput(), "key-1");
    const retry = await placeOrder.execute(aPlaceOrderInput(), "key-1");

    expect(retry).toEqual(first);
    expect(uow.orders.rows.size).toBe(1);
  });

  it("rejects the same key with a different payload", async () => {
    await placeOrder.execute(aPlaceOrderInput(), "key-1");

    await expect(placeOrder.execute(aPlaceOrderInput({ customerId: "someone-else" }), "key-1")).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
  });

  it("answers a concurrent request with the same key with a conflict", async () => {
    await store.reserve({ scope: "place-order", key: "key-1", fingerprint: fingerprint(aPlaceOrderInput()) });

    await expect(placeOrder.execute(aPlaceOrderInput(), "key-1")).rejects.toThrow(ConflictError);
  });

  it("releases the key when the command fails", async () => {
    await expect(placeOrder.execute(aPlaceOrderInput({ lines: [] }), "key-1")).rejects.toThrow(InvalidOrderError);

    expect(store.records.size).toBe(0);
  });

  it("places a new order on every call without a key", async () => {
    await placeOrder.execute(aPlaceOrderInput());
    await placeOrder.execute(aPlaceOrderInput());

    expect(uow.orders.rows.size).toBe(2);
  });
});
```

The SQL store's atomicity comes from the primary key, so test it against PostgreSQL (`usePrisma()` is in `domain-events-outbox.md`):

```typescript
// test/integration/prisma-idempotency.test.ts
import { describe, expect, it } from "vitest";
import { PrismaIdempotencyStore } from "../../src/orders/adapters/outbound/prisma/idempotency.store.js";
import { usePrisma } from "../support/prisma.js";

const prisma = usePrisma();

describe("PrismaIdempotencyStore", () => {
  it("reserves a key once, then returns the stored response", async () => {
    const store = new PrismaIdempotencyStore(prisma());
    const key = { scope: "place-order", key: "k-1", fingerprint: "f" };
    const response = { orderId: "order-1", totalCents: 3000, currency: "USD" };

    expect(await store.reserve(key)).toBeNull();
    expect(await store.reserve(key)).toEqual({ fingerprint: "f", response: null });
    await store.complete({ scope: "place-order", key: "k-1", response });
    expect((await store.reserve(key))?.response).toEqual(response);
  });

  it("allows a released key to be reserved again", async () => {
    const store = new PrismaIdempotencyStore(prisma());
    await store.reserve({ scope: "place-order", key: "k-1", fingerprint: "f" });

    await store.release({ scope: "place-order", key: "k-1" });

    expect(await store.reserve({ scope: "place-order", key: "k-1", fingerprint: "f" })).toBeNull();
  });
});
```

## Wiring

- **Outbound.** `PrismaIdempotencyStore`, `TypeOrmIdempotencyStore` or `DrizzleIdempotencyStore` in the persistence guides, section 7. Expire keys after a documented retention window (for example 24 hours).
- **Composition.** Wrap the plain use case: `new IdempotentPlaceOrder(placeOrder, new PrismaIdempotencyStore(prisma))`, and give the wrapper to the HTTP adapter.
- **HTTP.** Read the header and pass it through: `req.header("idempotency-key")` in Express, `request.headers["idempotency-key"]` in Fastify, `@Headers("idempotency-key")` in NestJS. Validate its length at the edge. Replayed responses return the same status and body as the original.
- **Errors.** `IdempotencyKeyReusedError` is a `DomainError` → 422; the "still in progress" `ConflictError` → 409. Both go through the existing family mapping.
- **Stricter APIs** can require the header on every `POST` and return 400 when it is missing.
