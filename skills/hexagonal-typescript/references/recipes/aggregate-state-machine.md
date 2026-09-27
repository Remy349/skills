# Recipe: aggregate with a state machine and optimistic concurrency

## Problem

An order moves through states (`pending → paid`, `pending → cancelled`) and some transitions must be impossible (cancel a paid order, pay twice). Two clients may act on the same order at the same time, and the loser must not silently overwrite the winner.

## Use it when / skip it when

- Use when: an entity has a lifecycle with rules about which operations are allowed in which state; concurrent edits are possible (several users, retries, background jobs).
- Skip when: the entity is plain data (use `crud-thin-slice.md`) or updates are last-write-wins by design.

## Design

- **The aggregate owns the transitions.** `Order.pay` and `Order.cancel` (in `../idioms.md`, section 4) check the current state through `ensureStatus` and throw `InvalidOrderTransitionError`, a `ConflictError`, so the HTTP adapter answers 409 without knowing the rule.
- **No setters.** State is private and exposed through getters; code outside the aggregate calls an intention-revealing method.
- **Optimistic concurrency** uses the `version` the aggregate was loaded with. Repositories update with `WHERE version = :loaded` and throw `ConflictError` when no row changes (see the persistence guides, section 6).
- **Client-side precondition.** The client sends the version it saw (`If-Match`); the use case rejects a mismatch with `StaleOrderError` before doing any work.

For larger machines, replace the per-method guards with a transition table so the allowed moves are data you can read and test in one place:

```ts
const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

private transitionTo(target: OrderStatus): void {
  if (!ALLOWED[this.state.status].includes(target)) {
    throw new InvalidOrderTransitionError(`cannot go from ${this.state.status} to ${target}`);
  }
  this.state = { ...this.state, status: target };
}
```

`Record<OrderStatus, ...>` makes the compiler demand an entry for every status, so adding a status forces a decision about its transitions.

## Code

The use case loads, checks the precondition, asks the aggregate to change, and saves. It contains no rule about which states allow cancelling.

```typescript
// src/orders/application/cancel-order.use-case.ts
import { OrderNotFoundError, StaleOrderError } from "../domain/errors.js";
import { OrderId } from "../domain/order.js";
import type { Clock, UnitOfWork } from "./ports.js";

export type CancelOrderInput = {
  readonly orderId: string;
  readonly reason: string;
  /** From If-Match; undefined skips the client-side check. */
  readonly expectedVersion?: number | undefined;
};

export class CancelOrderUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: CancelOrderInput): Promise<void> {
    await this.uow.run(async ({ orders }) => {
      const order = await orders.get(OrderId(input.orderId));
      if (order === null) throw new OrderNotFoundError(`order ${input.orderId} not found`);
      if (input.expectedVersion !== undefined && input.expectedVersion !== order.version) {
        throw new StaleOrderError(`order ${input.orderId} was modified (version ${order.version})`);
      }
      order.cancel({ reason: input.reason, now: this.clock.now() });
      await orders.update(order);
    });
  }
}
```

## Tests

Domain rules first, with no fakes at all:

```typescript
// test/orders/order.test.ts
import { describe, expect, it } from "vitest";
import { InvalidMoneyError, InvalidOrderError, InvalidOrderTransitionError } from "../../src/orders/domain/errors.js";
import { Money } from "../../src/orders/domain/money.js";
import { NOW, aLine, anOrder } from "./builders.js";

describe("Money", () => {
  it("rejects negative and fractional amounts", () => {
    expect(() => Money.of(-1, "USD")).toThrow(InvalidMoneyError);
    expect(() => Money.of(10.5, "USD")).toThrow(InvalidMoneyError);
  });

  it("refuses to add different currencies", () => {
    expect(() => Money.of(100, "USD").add(Money.of(100, "EUR"))).toThrow(InvalidMoneyError);
  });
});

describe("Order", () => {
  it("totals its lines", () => {
    const order = anOrder({
      lines: [aLine({ quantity: 2, unitPriceCents: 1500 }), aLine({ sku: "SKU-2", unitPriceCents: 250 })],
    });

    expect(order.total.equals(Money.of(3250, "USD"))).toBe(true);
  });

  it("needs at least one line in a single currency", () => {
    expect(() => anOrder({ lines: [] })).toThrow(InvalidOrderError);
    expect(() => anOrder({ lines: [aLine({ currency: "USD" }), aLine({ currency: "EUR" })] })).toThrow(
      InvalidOrderError,
    );
  });

  it("starts pending and records OrderPlaced once", () => {
    const order = anOrder();

    expect(order.status).toBe("pending");
    expect(order.pullEvents().map((event) => event.type)).toEqual(["OrderPlaced"]);
    expect(order.pullEvents()).toEqual([]);
  });

  it("can be paid once", () => {
    const order = anOrder();

    order.pay({ paymentId: "pay-1", now: NOW });

    expect(order.status).toBe("paid");
    expect(() => order.pay({ paymentId: "pay-2", now: NOW })).toThrow(InvalidOrderTransitionError);
  });

  it.each(["pay", "cancel"] as const)("cannot be cancelled after %s", (first) => {
    const order = anOrder();
    if (first === "pay") order.pay({ paymentId: "pay-1", now: NOW });
    else order.cancel({ reason: "changed my mind", now: NOW });

    expect(() => order.cancel({ reason: "again", now: NOW })).toThrow(InvalidOrderTransitionError);
  });
});
```

Then the use case with fakes, covering success, not found, stale version and the forbidden transition:

```typescript
// test/orders/cancel-order.use-case.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { CancelOrderUseCase } from "../../src/orders/application/cancel-order.use-case.js";
import { InvalidOrderTransitionError, OrderNotFoundError, StaleOrderError } from "../../src/orders/domain/errors.js";
import { OrderId } from "../../src/orders/domain/order.js";
import { FakeUnitOfWork, FixedClock, InMemoryOrderRepository } from "../support/fakes.js";
import { anOrder } from "./builders.js";

describe("CancelOrderUseCase", () => {
  let uow: FakeUnitOfWork;
  let cancelOrder: CancelOrderUseCase;

  beforeEach(async () => {
    const orders = new InMemoryOrderRepository();
    await orders.add(anOrder({ id: "order-1" })); // stored with version 1
    uow = new FakeUnitOfWork(orders);
    cancelOrder = new CancelOrderUseCase(uow, new FixedClock());
  });

  it("cancels a pending order and bumps its version", async () => {
    await cancelOrder.execute({ orderId: "order-1", reason: "changed my mind", expectedVersion: 1 });

    const stored = await uow.orders.get(OrderId("order-1"));
    expect(stored?.status).toBe("cancelled");
    expect(stored?.version).toBe(2);
  });

  it("rejects an unknown order", async () => {
    await expect(cancelOrder.execute({ orderId: "missing", reason: "x" })).rejects.toThrow(OrderNotFoundError);
  });

  it("rejects a stale version and changes nothing", async () => {
    await expect(cancelOrder.execute({ orderId: "order-1", reason: "x", expectedVersion: 7 })).rejects.toThrow(
      StaleOrderError,
    );

    expect((await uow.orders.get(OrderId("order-1")))?.status).toBe("pending");
  });

  it("cannot cancel twice", async () => {
    await cancelOrder.execute({ orderId: "order-1", reason: "first" });

    await expect(cancelOrder.execute({ orderId: "order-1", reason: "second" })).rejects.toThrow(
      InvalidOrderTransitionError,
    );
  });
});
```

## Wiring

- **HTTP.** `POST /orders/:orderId/cancellation` with `{ "reason": "..." }`; parse `If-Match` as an integer (`Number(req.header("if-match"))` after checking it is present and numeric) and pass it as `expectedVersion`. Return `204`. On reads, return the version in an `ETag` header so clients can send it back.
- **Errors.** `OrderNotFoundError` → 404, `InvalidOrderTransitionError` and `StaleOrderError` → 409, through the family mapping in `problem-details.ts`. No new handler is needed.
- **Composition.** `new CancelOrderUseCase(uow, clock)` in `composition.ts` (or a `useFactory` provider in NestJS).
