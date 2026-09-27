# Recipe: third-party API behind an Anti-Corruption Layer

## Problem

Paying an order requires a payment provider's REST API. Its model (charges, decline codes, lowercase currencies, vendor ids) and its failure modes (timeouts, 5xx, 402) must not leak into the domain, and a retried request must never charge twice.

## Use it when / skip it when

- Use when: integrating any system you do not control (payments, shipping, tax, identity, a legacy service). This is the default for generic subdomains.
- Skip when: never skip the port. For a trivial, stable integration the adapter can be very small, but it still translates.

## Design

- **The port speaks your language.** `PaymentGateway.Authorize(ctx, orderID, amount domain.Money, idempotencyKey)` returns a `PaymentAuthorization`. No vendor field appears in the application layer.
- **Two kinds of expected failure.** A declined payment is a business outcome (`ErrPaymentDeclined`, invalid → 422). An unreachable provider is a retryable unavailability (`ErrPaymentUnavailable`, `sharedkernel.Unavailable` → 503). Both are sentinels, so every framework maps them with no extra code. Anything else (a 401 because our key is wrong) is our bug and surfaces as a 500.
- **No remote call inside a transaction.** The use case reads and checks in one short unit of work, calls the provider with no transaction open, then applies the result in a second unit of work guarded by the aggregate's version.
- **Idempotency towards the provider.** The order id is the idempotency key, so a retried `PayOrder` cannot create a second charge.
- **The adapter owns** the base URL, authentication, timeout, request and response shapes, status-code interpretation and error translation.

## Code

Port, result type and errors, in the application layer:

```go
// internal/orders/app/payments.go
package app

import (
	"context"

	"shop/internal/orders/domain"
	"shop/internal/sharedkernel"
)

var (
	// ErrPaymentDeclined is a business outcome (422).
	ErrPaymentDeclined = sharedkernel.Invalid("PAYMENT_DECLINED", "payment declined")
	// ErrPaymentUnavailable means the provider could not be reached; the client may retry (503).
	ErrPaymentUnavailable = sharedkernel.Unavailable("PAYMENT_UNAVAILABLE", "payment provider unavailable")
)

type PaymentAuthorization struct {
	PaymentID string
}

// PaymentGateway is our model of payments. Adapters translate the vendor API into it and nothing else.
type PaymentGateway interface {
	// Authorize returns ErrPaymentDeclined or ErrPaymentUnavailable for the expected failures.
	Authorize(ctx context.Context, orderID domain.OrderID, amount domain.Money, idempotencyKey string) (PaymentAuthorization, error)
}
```

The use case:

```go
// internal/orders/app/pay_order.go
package app

import (
	"context"
	"fmt"

	"shop/internal/orders/domain"
)

type PayOrderInput struct {
	OrderID string
}

type PayOrderOutput struct {
	OrderID   string
	PaymentID string
}

type PayOrder struct {
	uow      UnitOfWork
	payments PaymentGateway
	clock    Clock
}

func NewPayOrder(uow UnitOfWork, payments PaymentGateway, clock Clock) *PayOrder {
	return &PayOrder{uow: uow, payments: payments, clock: clock}
}

func (uc *PayOrder) Execute(ctx context.Context, in PayOrderInput) (PayOrderOutput, error) {
	orderID := domain.OrderID(in.OrderID)

	// 1. Read and check the rule in a short transaction.
	var amount domain.Money
	err := uc.uow.Do(ctx, func(tx Tx) error {
		order, err := tx.Orders().Get(ctx, orderID)
		if err != nil {
			return err
		}
		if order.Status() != domain.StatusPending {
			return fmt.Errorf("%w: cannot pay an order that is %s", domain.ErrInvalidTransition, order.Status())
		}
		amount = order.Total()
		return nil
	})
	if err != nil {
		return PayOrderOutput{}, err
	}

	// 2. Call the remote system outside any database transaction.
	//    The order id is the idempotency key, so a retry never charges twice.
	authorization, err := uc.payments.Authorize(ctx, orderID, amount, in.OrderID)
	if err != nil {
		return PayOrderOutput{}, err
	}

	// 3. Apply the result in a new transaction; the version check detects concurrent changes.
	err = uc.uow.Do(ctx, func(tx Tx) error {
		order, err := tx.Orders().Get(ctx, orderID)
		if err != nil {
			return err
		}
		if err := order.Pay(authorization.PaymentID, uc.clock.Now()); err != nil {
			return err
		}
		return tx.Orders().Update(ctx, order)
	})
	if err != nil {
		return PayOrderOutput{}, err
	}
	return PayOrderOutput{OrderID: in.OrderID, PaymentID: authorization.PaymentID}, nil
}
```

If step 3 fails (the order changed meanwhile), the charge exists but the order is not marked paid. Handle that explicitly for your domain: retry `PayOrder` (the idempotency key returns the same charge), or record the authorization and reconcile. Never wrap step 2 in the database transaction to "fix" it.

The adapter, with `net/http`:

```go
// internal/orders/adapters/outbound/payments/gateway.go
// Package payments is an Anti-Corruption Layer over the payment provider's REST API.
// Vendor fields, status codes and errors never leave this package.
package payments

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
)

type Gateway struct {
	client  *http.Client // with a Timeout, configured in the composition root
	baseURL string
	apiKey  string
}

func NewGateway(client *http.Client, baseURL, apiKey string) *Gateway {
	return &Gateway{client: client, baseURL: strings.TrimSuffix(baseURL, "/"), apiKey: apiKey}
}

type chargeRequest struct {
	Amount    int64  `json:"amount"`
	Currency  string `json:"currency"`
	Reference string `json:"reference"`
}

type chargeResponse struct {
	ID string `json:"id"`
}

type declineResponse struct {
	DeclineCode string `json:"decline_code"`
}

func (g *Gateway) Authorize(ctx context.Context, orderID domain.OrderID, amount domain.Money, idempotencyKey string) (app.PaymentAuthorization, error) {
	body, err := json.Marshal(chargeRequest{
		Amount:    amount.Amount(),
		Currency:  strings.ToLower(amount.Currency()), // the vendor wants lowercase codes
		Reference: string(orderID),
	})
	if err != nil {
		return app.PaymentAuthorization{}, fmt.Errorf("encode charge: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+"/v1/charges", bytes.NewReader(body))
	if err != nil {
		return app.PaymentAuthorization{}, fmt.Errorf("build charge request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+g.apiKey)
	req.Header.Set("Idempotency-Key", idempotencyKey)

	res, err := g.client.Do(req)
	if err != nil { // connection errors and timeouts
		return app.PaymentAuthorization{}, fmt.Errorf("%w: %w", app.ErrPaymentUnavailable, err)
	}
	defer func() { _ = res.Body.Close() }()

	switch {
	case res.StatusCode == http.StatusPaymentRequired:
		var decline declineResponse
		_ = json.NewDecoder(res.Body).Decode(&decline)
		return app.PaymentAuthorization{}, fmt.Errorf("%w: %s", app.ErrPaymentDeclined, cmp.Or(decline.DeclineCode, "unknown"))
	case res.StatusCode >= http.StatusInternalServerError:
		return app.PaymentAuthorization{}, fmt.Errorf("%w: provider answered %d", app.ErrPaymentUnavailable, res.StatusCode)
	case res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated:
		// Any other 4xx is our bug (bad key, bad request): let it surface as a 500.
		return app.PaymentAuthorization{}, fmt.Errorf("payment provider rejected the charge with %d", res.StatusCode)
	}

	var charge chargeResponse
	if err := json.NewDecoder(res.Body).Decode(&charge); err != nil || charge.ID == "" {
		return app.PaymentAuthorization{}, fmt.Errorf("payment provider returned an invalid charge: %v", err)
	}
	return app.PaymentAuthorization{PaymentID: charge.ID}, nil
}
```

`fmt.Errorf("%w: %w", app.ErrPaymentUnavailable, err)` keeps both the family (for the HTTP mapping) and the transport cause (for the log line).

## Tests

A fake of the port, in a new file of `orderstest`:

```go
// internal/orders/orderstest/payments.go
package orderstest

import (
	"context"
	"fmt"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
)

type AuthorizeCall struct {
	OrderID        domain.OrderID
	Amount         domain.Money
	IdempotencyKey string
}

// FakePaymentGateway approves every charge unless Decline is set, and records its calls.
type FakePaymentGateway struct {
	Decline bool
	Calls   []AuthorizeCall
}

func (g *FakePaymentGateway) Authorize(_ context.Context, orderID domain.OrderID, amount domain.Money, key string) (app.PaymentAuthorization, error) {
	g.Calls = append(g.Calls, AuthorizeCall{OrderID: orderID, Amount: amount, IdempotencyKey: key})
	if g.Decline {
		return app.PaymentAuthorization{}, fmt.Errorf("%w: insufficient_funds", app.ErrPaymentDeclined)
	}
	return app.PaymentAuthorization{PaymentID: "pay-" + string(orderID)}, nil
}
```

Use case behavior:

```go
// internal/orders/app/pay_order_test.go
package app_test

import (
	"context"
	"errors"
	"testing"

	"shop/internal/orders/app"
	"shop/internal/orders/domain"
	"shop/internal/orders/orderstest"
)

func newPayOrder(t *testing.T, gateway *orderstest.FakePaymentGateway) (*app.PayOrder, *orderstest.FakeUnitOfWork) {
	t.Helper()
	uow := orderstest.NewFakeUnitOfWork()
	if err := uow.Committed.Add(context.Background(), orderstest.Order(t, "order-1")); err != nil {
		t.Fatal(err)
	}
	return app.NewPayOrder(uow, gateway, orderstest.NewFixedClock()), uow
}

func TestPayOrderAuthorizesTheTotalAndMarksTheOrderPaid(t *testing.T) {
	gateway := &orderstest.FakePaymentGateway{}
	payOrder, uow := newPayOrder(t, gateway)

	out, err := payOrder.Execute(context.Background(), app.PayOrderInput{OrderID: "order-1"})

	if err != nil {
		t.Fatal(err)
	}
	if want := (app.PayOrderOutput{OrderID: "order-1", PaymentID: "pay-order-1"}); out != want {
		t.Fatalf("output = %+v", out)
	}
	amount, _ := domain.NewMoney(1000, "USD")
	if want := (orderstest.AuthorizeCall{OrderID: "order-1", Amount: amount, IdempotencyKey: "order-1"}); len(gateway.Calls) != 1 || gateway.Calls[0] != want {
		t.Fatalf("calls = %+v", gateway.Calls)
	}
	stored, _ := uow.Committed.Get(context.Background(), "order-1")
	if stored.Status() != domain.StatusPaid {
		t.Fatalf("status = %s", stored.Status())
	}
}

func TestPayOrderDeclinedLeavesTheOrderPending(t *testing.T) {
	payOrder, uow := newPayOrder(t, &orderstest.FakePaymentGateway{Decline: true})

	_, err := payOrder.Execute(context.Background(), app.PayOrderInput{OrderID: "order-1"})

	if !errors.Is(err, app.ErrPaymentDeclined) {
		t.Fatalf("err = %v, want ErrPaymentDeclined", err)
	}
	stored, _ := uow.Committed.Get(context.Background(), "order-1")
	if stored.Status() != domain.StatusPending {
		t.Fatalf("status = %s", stored.Status())
	}
}

func TestPayOrderDoesNotChargeAPaidOrder(t *testing.T) {
	gateway := &orderstest.FakePaymentGateway{}
	payOrder, _ := newPayOrder(t, gateway)
	if _, err := payOrder.Execute(context.Background(), app.PayOrderInput{OrderID: "order-1"}); err != nil {
		t.Fatal(err)
	}

	_, err := payOrder.Execute(context.Background(), app.PayOrderInput{OrderID: "order-1"})

	if !errors.Is(err, domain.ErrInvalidTransition) || len(gateway.Calls) != 1 {
		t.Fatalf("err = %v, calls = %d", err, len(gateway.Calls))
	}
}
```

The adapter against a scripted vendor API, with no network:

```go
// internal/orders/adapters/outbound/payments/gateway_test.go
package payments_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"shop/internal/orders/adapters/outbound/payments"
	"shop/internal/orders/app"
	"shop/internal/orders/domain"
)

func usd(t *testing.T, cents int64) domain.Money {
	t.Helper()
	m, err := domain.NewMoney(cents, "USD")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// provider runs a scripted vendor API in-process: the real adapter, no network.
func provider(t *testing.T, handler http.HandlerFunc) *payments.Gateway {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return payments.NewGateway(&http.Client{Timeout: 100 * time.Millisecond}, server.URL, "test-key")
}

func TestTranslatesASuccessfulCharge(t *testing.T) {
	gateway := provider(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Idempotency-Key") != "order-1" || string(body) != `{"amount":1000,"currency":"usd","reference":"order-1"}` {
			t.Errorf("unexpected request: %s %s", r.Header, body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"id":"ch_123","object":"charge","livemode":false}`)
	})

	got, err := gateway.Authorize(context.Background(), "order-1", usd(t, 1000), "order-1")

	if err != nil || got != (app.PaymentAuthorization{PaymentID: "ch_123"}) {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestFailuresAreTranslated(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		want    error
	}{
		{"402 is a decline", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusPaymentRequired)
			_, _ = io.WriteString(w, `{"decline_code":"insufficient_funds"}`)
		}, app.ErrPaymentDeclined},
		{"5xx is unavailable", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		}, app.ErrPaymentUnavailable},
		{"a timeout is unavailable", func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-time.After(time.Second):
			case <-r.Context().Done():
			}
		}, app.ErrPaymentUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := provider(t, tt.handler).Authorize(context.Background(), "o", usd(t, 1), "o")

			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestUnreachableProviderIsUnavailable(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	server.Close() // nothing listens on this address any more
	gateway := payments.NewGateway(&http.Client{Timeout: time.Second}, server.URL, "test-key")

	_, err := gateway.Authorize(context.Background(), "o", usd(t, 1), "o")

	if !errors.Is(err, app.ErrPaymentUnavailable) {
		t.Fatalf("err = %v, want ErrPaymentUnavailable", err)
	}
}

func TestOther4xxIsOurBugNotABusinessError(t *testing.T) {
	gateway := provider(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) })

	_, err := gateway.Authorize(context.Background(), "o", usd(t, 1), "o")

	if err == nil || errors.Is(err, app.ErrPaymentDeclined) || errors.Is(err, app.ErrPaymentUnavailable) {
		t.Fatalf("err = %v, want an unexpected error", err)
	}
}
```

## Wiring

- **Composition.** Create one `*http.Client` at startup with a `Timeout` from config (add `PaymentsBaseURL`, `PaymentsAPIKey` and `PaymentsTimeout` to `config.Config`), pass it to `payments.NewGateway`, and the gateway to `app.NewPayOrder`. Never use `http.DefaultClient`: it has no timeout.
- **HTTP.** `POST /orders/{id}/payment` returns `200` with `{"orderId", "paymentId"}`. `ErrPaymentDeclined` → 422 and `ErrPaymentUnavailable` → 503 come from the family mapping; the 503 is logged with its cause by the central error handler.
- **Secrets.** The API key comes from the environment or a secret manager, is never logged, and is sent only by the adapter.
- **Resilience.** Retries with backoff for idempotent calls, and a circuit breaker if the provider fails often, belong in the adapter or in a decorator that implements the same port, never in the use case.
