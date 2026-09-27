# Recipe: third-party API behind an Anti-Corruption Layer

## Problem

Paying an order requires a payment provider's REST API. Its model (charges, decline codes, lowercase currencies, vendor ids) and its failure modes (timeouts, 5xx, 402) must not leak into the domain, and a retried request must never charge twice.

## Use it when / skip it when

- Use when: integrating any system you do not control (payments, shipping, tax, identity, a legacy service). This is the default for generic subdomains.
- Skip when: never skip the port. For a trivial, stable integration the adapter can be very small, but it still translates.

## Design

- **The port speaks your language.** `PaymentGateway.authorize({ orderId, amount: Money, idempotencyKey })` returns a `PaymentAuthorization`. No vendor field appears in the application layer, and the vendor SDK (if any) is imported only by the adapter.
- **Two kinds of failure.** A declined payment is a business outcome (`PaymentDeclinedError`, a `DomainError` → 422). An unreachable provider is infrastructure (`PaymentUnavailableError`, a plain `Error` → 503).
- **No remote call inside a transaction.** The use case reads and checks in one short unit of work, calls the provider with no transaction open, then applies the result in a second unit of work guarded by the aggregate's version.
- **Idempotency towards the provider.** The order id is the idempotency key, so a retried `PayOrder` cannot create a second charge.
- **The adapter owns** the base URL, authentication, timeout (`AbortSignal.timeout`), request and response shapes, status-code interpretation and error translation.

## Code

Port, result type and errors, in the application layer:

```typescript
// src/orders/application/payments.ts
import type { Money } from "../domain/money.js";
import { DomainError } from "../../shared-kernel/errors.js";

export class PaymentDeclinedError extends DomainError {
  override readonly code = "PAYMENT_DECLINED";
}

/** The provider could not be reached. Infrastructure failure, mapped to 503. */
export class PaymentUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentUnavailableError";
  }
}

export type PaymentAuthorization = { readonly paymentId: string };

/** Our model of payments. Adapters translate the vendor API into this and nothing else. */
export interface PaymentGateway {
  /** Rejects with PaymentDeclinedError or PaymentUnavailableError. */
  authorize(input: { orderId: string; amount: Money; idempotencyKey: string }): Promise<PaymentAuthorization>;
}
```

The use case:

```typescript
// src/orders/application/pay-order.use-case.ts
import { InvalidOrderTransitionError, OrderNotFoundError } from "../domain/errors.js";
import { OrderId } from "../domain/order.js";
import type { PaymentGateway } from "./payments.js";
import type { Clock, UnitOfWork } from "./ports.js";

export type PayOrderInput = { readonly orderId: string };
export type PayOrderOutput = { readonly orderId: string; readonly paymentId: string };

export class PayOrderUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly payments: PaymentGateway,
    private readonly clock: Clock,
  ) {}

  async execute(input: PayOrderInput): Promise<PayOrderOutput> {
    const orderId = OrderId(input.orderId);

    // 1. Read and check the rule in a short transaction.
    const amount = await this.uow.run(async ({ orders }) => {
      const order = await orders.get(orderId);
      if (order === null) throw new OrderNotFoundError(`order ${orderId} not found`);
      if (order.status !== "pending")
        throw new InvalidOrderTransitionError(`cannot pay an order that is ${order.status}`);
      return order.total;
    });

    // 2. Call the remote system outside any database transaction.
    //    The order id is the idempotency key, so a retry never charges twice.
    const { paymentId } = await this.payments.authorize({ orderId, amount, idempotencyKey: orderId });

    // 3. Apply the result in a new transaction; the version check detects concurrent changes.
    await this.uow.run(async ({ orders }) => {
      const order = await orders.get(orderId);
      if (order === null) throw new OrderNotFoundError(`order ${orderId} not found`);
      order.pay({ paymentId, now: this.clock.now() });
      await orders.update(order);
    });

    return { orderId, paymentId };
  }
}
```

If step 3 fails (the order changed meanwhile), the charge exists but the order is not marked paid. Handle that explicitly for your domain: retry `PayOrder` (the idempotency key returns the same charge), or record the authorization and reconcile. Never move step 2 inside the transaction to "fix" it.

The adapter, with the platform `fetch` (injectable for tests):

```typescript
// src/orders/adapters/outbound/payments/http-payment-gateway.ts
import {
  type PaymentAuthorization,
  PaymentDeclinedError,
  type PaymentGateway,
  PaymentUnavailableError,
} from "../../../application/payments.js";
import type { Money } from "../../../domain/money.js";

export type HttpPaymentGatewayOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch; // injectable for tests
};

/** Anti-Corruption Layer over the provider's REST API. Vendor fields and errors never leave this class. */
export class HttpPaymentGateway implements PaymentGateway {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: HttpPaymentGatewayOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async authorize(input: { orderId: string; amount: Money; idempotencyKey: string }): Promise<PaymentAuthorization> {
    let response: Response;
    try {
      response = await this.fetch(new URL("/v1/charges", this.options.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify({
          amount: input.amount.amount,
          currency: input.amount.currency.toLowerCase(),
          reference: input.orderId,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // network failure or timeout
      throw new PaymentUnavailableError("payment provider unreachable", { cause: error });
    }

    if (response.status === 402) {
      const body = (await response.json()) as { decline_code?: string };
      throw new PaymentDeclinedError(`payment declined: ${body.decline_code ?? "unknown"}`);
    }
    if (response.status >= 500) {
      throw new PaymentUnavailableError(`payment provider failed with ${response.status}`);
    }
    if (!response.ok) {
      // any other 4xx is our bug: let it surface as a 500
      throw new Error(`unexpected payment provider response ${response.status}`);
    }

    const body = (await response.json()) as { id: string };
    return { paymentId: body.id };
  }
}
```

With a vendor SDK instead of `fetch`, the shape is identical: the SDK client is created in the composition root, passed to the adapter, and its errors are translated here.

## Tests

Fake of the port, added to the shared fakes:

```ts
// test/support/fakes.ts  (addition)
import type { PaymentAuthorization, PaymentGateway } from "../../src/orders/application/payments.js";
import { PaymentDeclinedError } from "../../src/orders/application/payments.js";
import type { Money } from "../../src/orders/domain/money.js";

export class FakePaymentGateway implements PaymentGateway {
  readonly calls: { orderId: string; amount: Money; idempotencyKey: string }[] = [];

  constructor(private readonly options: { decline?: boolean } = {}) {}

  async authorize(input: { orderId: string; amount: Money; idempotencyKey: string }): Promise<PaymentAuthorization> {
    this.calls.push(input);
    if (this.options.decline) throw new PaymentDeclinedError("payment declined: insufficient_funds");
    return { paymentId: `pay-${input.orderId}` };
  }
}
```

Use case behavior:

```typescript
// test/orders/pay-order.use-case.test.ts
import { describe, expect, it } from "vitest";
import { PayOrderUseCase } from "../../src/orders/application/pay-order.use-case.js";
import { PaymentDeclinedError } from "../../src/orders/application/payments.js";
import { InvalidOrderTransitionError } from "../../src/orders/domain/errors.js";
import { Money } from "../../src/orders/domain/money.js";
import { OrderId } from "../../src/orders/domain/order.js";
import { FakePaymentGateway, FakeUnitOfWork, FixedClock, InMemoryOrderRepository } from "../support/fakes.js";
import { anOrder } from "./builders.js";

const setUp = async (gateway: FakePaymentGateway) => {
  const orders = new InMemoryOrderRepository();
  await orders.add(anOrder({ id: "order-1" }));
  const uow = new FakeUnitOfWork(orders);
  return { uow, payOrder: new PayOrderUseCase(uow, gateway, new FixedClock()) };
};

describe("PayOrderUseCase", () => {
  it("authorizes the order total and marks the order paid", async () => {
    const gateway = new FakePaymentGateway();
    const { uow, payOrder } = await setUp(gateway);

    const output = await payOrder.execute({ orderId: "order-1" });

    expect(output).toEqual({ orderId: "order-1", paymentId: "pay-order-1" });
    expect(gateway.calls).toEqual([{ orderId: "order-1", amount: Money.of(1000, "USD"), idempotencyKey: "order-1" }]);
    expect((await uow.orders.get(OrderId("order-1")))?.status).toBe("paid");
  });

  it("leaves the order pending when the payment is declined", async () => {
    const { uow, payOrder } = await setUp(new FakePaymentGateway({ decline: true }));

    await expect(payOrder.execute({ orderId: "order-1" })).rejects.toThrow(PaymentDeclinedError);

    expect((await uow.orders.get(OrderId("order-1")))?.status).toBe("pending");
  });

  it("does not charge an order that is already paid", async () => {
    const gateway = new FakePaymentGateway();
    const { payOrder } = await setUp(gateway);
    await payOrder.execute({ orderId: "order-1" });

    await expect(payOrder.execute({ orderId: "order-1" })).rejects.toThrow(InvalidOrderTransitionError);

    expect(gateway.calls).toHaveLength(1);
  });
});
```

The adapter against scripted responses, with no network:

```typescript
// test/orders/http-payment-gateway.test.ts
import { describe, expect, it } from "vitest";
import { HttpPaymentGateway } from "../../src/orders/adapters/outbound/payments/http-payment-gateway.js";
import { PaymentDeclinedError, PaymentUnavailableError } from "../../src/orders/application/payments.js";
import { Money } from "../../src/orders/domain/money.js";

const gateway = (fetch: typeof globalThis.fetch) =>
  new HttpPaymentGateway({ baseUrl: "https://payments.test", apiKey: "sk_test", timeoutMs: 1000, fetch });

const charge = { orderId: "order-1", amount: Money.of(1000, "USD"), idempotencyKey: "order-1" };

describe("HttpPaymentGateway", () => {
  it("translates a successful charge", async () => {
    let sent: Request | undefined;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      sent = new Request(url, init);
      return Response.json({ id: "ch_123", object: "charge", livemode: false }, { status: 201 });
    };

    const result = await gateway(fetch).authorize(charge);

    expect(result).toEqual({ paymentId: "ch_123" });
    expect(sent?.headers.get("idempotency-key")).toBe("order-1");
    expect(await sent?.json()).toEqual({ amount: 1000, currency: "usd", reference: "order-1" });
  });

  it("maps 402 to PaymentDeclinedError", async () => {
    const fetch = async () => Response.json({ decline_code: "insufficient_funds" }, { status: 402 });

    await expect(gateway(fetch).authorize(charge)).rejects.toThrow(PaymentDeclinedError);
  });

  it.each([
    ["a 5xx response", async () => new Response(null, { status: 503 })],
    ["a timeout", async () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
  ])("maps %s to PaymentUnavailableError", async (_, fetch: typeof globalThis.fetch) => {
    await expect(gateway(fetch).authorize(charge)).rejects.toThrow(PaymentUnavailableError);
  });
});
```

## Wiring

- **Composition.** Read `PAYMENTS_BASE_URL`, `PAYMENTS_API_KEY` and `PAYMENTS_TIMEOUT_MS` in `bootstrap/config.ts`, then `new PayOrderUseCase(uow, new HttpPaymentGateway({ baseUrl, apiKey, timeoutMs }), clock)`.
- **HTTP errors.** `PaymentDeclinedError` is a `DomainError`, so the family mapping returns 422. Add the infrastructure error to `toProblem` in `problem-details.ts`:

```ts
if (error instanceof PaymentUnavailableError) {
  return { type: "about:blank", title: "Payment provider unavailable", status: 503, code: "UPSTREAM_UNAVAILABLE" };
}
```

- **Resilience.** Retries with backoff for idempotent calls, and a circuit breaker if the provider fails often, belong in the adapter (or a decorator implementing the same port), never in the use case.
