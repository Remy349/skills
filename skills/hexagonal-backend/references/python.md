# Python reference

Applies to FastAPI, Flask, Django/DRF, Litestar and plain ASGI/WSGI services. Target Python 3.11+ unless the project pins otherwise.

## Contents
1. Detection and tooling
2. Naming and style conventions
3. Layout
4. Vertical slice example (PlaceOrder)
5. FastAPI wiring
6. Flask and Django notes
7. Errors
8. Persistence adapters
9. Testing
10. Pitfalls
11. Architecture enforcement

## 1. Detection and tooling

- Dependency manager: follow the project (`uv`, `poetry`, `pip-tools`, `pip` + `requirements.txt`). Config in `pyproject.toml`.
- Formatter/linter: keep what exists (`ruff` for lint+format is the modern default; otherwise `black` + `isort` + `flake8`). Type checker: `mypy --strict` or `pyright`. Add type hints to every public function.
- Async vs sync: match the framework and driver. FastAPI with async adapters uses `async def` end to end; never call blocking I/O inside `async def` (use an async driver or a thread pool). Do not mix sync and async ports randomly: choose one style per service.
- Use a `src/` layout so the package is importable only when installed, avoiding accidental path imports.

## 2. Naming and style conventions

- Follow **PEP 8** and **PEP 257**. Modules and packages: `lower_snake_case`, short. Classes: `PascalCase`. Functions, methods, variables: `snake_case`. Constants: `UPPER_SNAKE_CASE`. Private: leading underscore. Type variables: `T`, `TKey`.
- Type hints per **PEP 484/604**: `str | None` not `Optional[str]`, `list[str]` not `List[str]`. Use `collections.abc` for parameters (`Sequence`, `Mapping`, `Iterable`), concrete types for returns.
- Ports: `typing.Protocol` classes (structural typing: any object with the right methods is a valid adapter, so fakes need no inheritance). Use `abc.ABC` only when you want explicit inheritance and runtime enforcement.
- Domain models: `@dataclass(frozen=True, slots=True)` for value objects and immutable entities; regular classes when identity and behavior dominate. Pydantic models are for **boundaries** (request/response DTOs, settings), not the domain, unless the project consciously chooses otherwise.
- `Enum`/`StrEnum` for closed sets. `datetime.now(UTC)` (not the deprecated `utcnow()`); inject a clock. Money: `Decimal` or integer minor units, never `float`.
- Docstrings for public modules, classes and functions (Google or NumPy style, whichever the repo uses). Prefer `pathlib`, f-strings, comprehensions when readable, context managers for resources.
- Do not use mutable default arguments. Avoid `from x import *`. Keep `__init__.py` light (no logic, few re-exports).
- No bare `except:`; catch specific exceptions; use `raise NewError(...) from err` to keep the cause.

## 3. Layout

```
src/shop/
  orders/
    domain/
      order.py
      errors.py
    application/
      ports.py              # outbound ports (Protocols)
      place_order.py        # use case + Input/Output dataclasses
    adapters/
      inbound/http/
        router.py           # FastAPI router (or Flask blueprint)
        schemas.py          # Pydantic request/response models
        error_handlers.py
      outbound/
        sqlalchemy/
          models.py         # ORM models (persistence only)
          repository.py
        payments/stripe_gateway.py
    composition.py          # factories / dependency providers
  bootstrap/
    app.py  settings.py  logging.py
tests/
  orders/{domain,application,adapters,e2e}/
  support/fakes.py
```

## 4. Vertical slice example (PlaceOrder)

```python
# orders/domain/errors.py
class DomainError(Exception):
    code = "DOMAIN_ERROR"

class InvalidOrderError(DomainError):
    code = "ORDER_INVALID"

class OrderNotFoundError(DomainError):
    code = "ORDER_NOT_FOUND"
```

```python
# orders/domain/order.py
from __future__ import annotations

from dataclasses import dataclass, replace

from .errors import InvalidOrderError


@dataclass(frozen=True, slots=True)
class Order:
    id: str
    amount_cents: int
    status: str = "pending"
    authorization_id: str | None = None

    @classmethod
    def create(cls, *, id: str, amount_cents: int) -> Order:
        if amount_cents <= 0:
            raise InvalidOrderError("amount_cents must be positive")
        return cls(id=id, amount_cents=amount_cents)

    def mark_authorized(self, authorization_id: str) -> Order:
        return replace(self, status="authorized", authorization_id=authorization_id)
```

```python
# orders/application/ports.py
from typing import Protocol

from ..domain.order import Order


class OrderRepository(Protocol):
    async def save(self, order: Order) -> None: ...
    async def find_by_id(self, order_id: str) -> Order | None: ...


class PaymentGateway(Protocol):
    async def authorize(self, *, order_id: str, amount_cents: int) -> str:
        """Return the authorization id."""
        ...


class IdGenerator(Protocol):
    def next(self) -> str: ...
```

```python
# orders/application/place_order.py
from dataclasses import dataclass

from ..domain.order import Order
from .ports import IdGenerator, OrderRepository, PaymentGateway


@dataclass(frozen=True, slots=True)
class PlaceOrderInput:
    amount_cents: int


@dataclass(frozen=True, slots=True)
class PlaceOrderOutput:
    order_id: str
    authorization_id: str


class PlaceOrder:
    def __init__(self, orders: OrderRepository, payments: PaymentGateway, ids: IdGenerator) -> None:
        self._orders = orders
        self._payments = payments
        self._ids = ids

    async def execute(self, data: PlaceOrderInput) -> PlaceOrderOutput:
        order = Order.create(id=self._ids.next(), amount_cents=data.amount_cents)
        authorization_id = await self._payments.authorize(order_id=order.id, amount_cents=order.amount_cents)
        await self._orders.save(order.mark_authorized(authorization_id))
        return PlaceOrderOutput(order_id=order.id, authorization_id=authorization_id)
```

## 5. FastAPI wiring

```python
# orders/adapters/inbound/http/schemas.py
from pydantic import BaseModel, ConfigDict, Field


class PlaceOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount_cents: int = Field(gt=0)


class PlaceOrderResponse(BaseModel):
    order_id: str
    authorization_id: str
```

```python
# orders/adapters/inbound/http/router.py
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ....application.place_order import PlaceOrder, PlaceOrderInput
from .schemas import PlaceOrderRequest, PlaceOrderResponse


def build_router(get_place_order: Callable[..., PlaceOrder]) -> APIRouter:
    """The provider is injected by the composition root, so this adapter never imports outbound adapters."""
    router = APIRouter(prefix="/orders", tags=["orders"])

    @router.post("", status_code=status.HTTP_201_CREATED, response_model=PlaceOrderResponse)
    async def place_order(
        body: PlaceOrderRequest,
        response: Response,
        use_case: Annotated[PlaceOrder, Depends(get_place_order)],
    ) -> PlaceOrderResponse:
        out = await use_case.execute(PlaceOrderInput(amount_cents=body.amount_cents))
        response.headers["Location"] = f"/orders/{out.order_id}"
        return PlaceOrderResponse(order_id=out.order_id, authorization_id=out.authorization_id)

    return router
```

```python
# orders/adapters/inbound/http/error_handlers.py
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ....domain.errors import DomainError, InvalidOrderError, OrderNotFoundError

_STATUS: dict[type[DomainError], int] = {InvalidOrderError: 422, OrderNotFoundError: 404}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def handle_domain_error(request: Request, exc: DomainError) -> JSONResponse:
        status_code = next((s for t, s in _STATUS.items() if isinstance(exc, t)), 400)
        return JSONResponse(
            status_code=status_code,
            media_type="application/problem+json",
            content={"title": str(exc), "status": status_code, "code": exc.code, "instance": request.url.path},
        )
```

Composition (`composition.py`) is the only module that knows both sides. It builds the providers from long-lived resources stored on `app.state` (session factory, HTTP client) created in the `lifespan` handler, and hands them to the router factory:

```python
# orders/composition.py
def get_place_order(request: Request, session: Annotated[AsyncSession, Depends(get_session)]) -> PlaceOrder:
    return PlaceOrder(
        orders=SqlAlchemyOrderRepository(session),
        payments=request.app.state.payment_gateway,
        ids=UuidGenerator(),
    )


def include_orders(app: FastAPI) -> None:
    app.include_router(build_router(get_place_order))
```

Rules: settings via `pydantic-settings` loaded once in `bootstrap/settings.py`; resources opened/closed in `lifespan`; FastAPI `Depends` appears only in inbound adapters and the composition module, never in the domain or application layers. Tests override providers with `app.dependency_overrides[get_place_order] = lambda: PlaceOrder(fakes...)`.

## 6. Flask and Django notes

**Flask**: use the application factory `create_app(container)`; blueprints are inbound adapters; build use cases in the factory and pass them to blueprint registration functions (`register_orders(app, place_order)`) instead of importing globals. Validate with Pydantic or marshmallow in the view; register `@app.errorhandler(DomainError)` for mapping. Avoid `flask.g`/`current_app` inside use cases. Flask-SQLAlchemy's `db.Model` classes are persistence models: map to the domain in the repository.

**Django / DRF**: the framework encourages Active Record. Pragmatic hexagonal approach: views/viewsets/serializers are inbound adapters (keep them thin); Django models and `QuerySet`s live in an outbound adapter behind repository/query ports; business rules live in `domain/` and `application/`, not in models, serializers, signals or `save()` overrides. For simple CRUD admin-style apps, accept plain Django and apply the thin-slice depth; introduce ports where rules or integrations appear.

## 7. Errors

- Exceptions are the idiom. One `DomainError` base with a stable `code`; subclasses for expected business failures. Application-level errors (`ConflictError`, `NotFoundError`) live in the application layer. Adapters translate `sqlalchemy.exc.IntegrityError`, `httpx.TimeoutException`, etc. into these, using `raise ... from err`.
- Map exceptions to HTTP in one exception-handler module. Return `application/problem+json`. Unknown exceptions become a generic 500 with a trace id; log once with `logger.exception`.
- Validation errors from Pydantic/FastAPI (`RequestValidationError`) should be reformatted to the same Problem Details shape.

## 8. Persistence adapters

- SQLAlchemy 2.0 style (`select()`, `Mapped[...]`, typed `AsyncSession`). ORM models stay in `adapters/outbound/sqlalchemy/models.py`; repositories return domain objects through explicit mapper functions (`to_domain`, `to_row`). Alternative: imperative mapping to keep domain classes clean, at the cost of more setup; pick one per project.
- Unit of Work: an async context manager wrapping the session/transaction, exposed as a port when several repositories must commit together. Commit in the use case boundary (UoW), not in repositories.
- Migrations with Alembic; run them in integration tests.
- Never leak an `AsyncSession` into use cases or return lazy-loaded ORM objects across the boundary.

## 9. Testing

- `pytest` with fixtures; fakes in `tests/support/fakes.py` (`InMemoryOrderRepository`, `FakePaymentGateway`, `SequentialIds`). Parametrize with `@pytest.mark.parametrize`. Async tests via `pytest-asyncio` or `anyio`.
- Test names describe behavior: `test_place_order_rejects_non_positive_amount`.
- Inbound tests: `httpx.AsyncClient(transport=ASGITransport(app=app))` (FastAPI) or Flask's `app.test_client()`, with `dependency_overrides` swapping in fakes.
- Integration tests: `testcontainers` (PostgreSQL) plus real Alembic migrations; use a transaction-per-test fixture with rollback.
- Contract suites as base test classes parameterized by a `make_repository` fixture.
- Hypothesis for value-object properties; `freezegun` or an injected clock for time; `respx`/`pytest-httpx` to stub outbound HTTP.
- Run `ruff check`, `ruff format --check`, `mypy`, `pytest -q` in CI.

## 10. Pitfalls

- Circular imports between layers: depend on `ports.py`, import concrete adapters only in composition. Use `TYPE_CHECKING` imports for type-only references.
- Module-level singletons (engine, client, settings) created at import time make tests and startup order fragile; create them in the factory/`lifespan`.
- `float` for money, naive datetimes, mutable default arguments, shared mutable class attributes.
- Blocking calls in `async def` (sync ORM, `requests`, `time.sleep`) stall the event loop.
- Returning ORM instances or Pydantic models from use cases couples them to adapters; return application dataclasses.
- Overusing `Any`; missing type hints on ports (the whole point of `Protocol` is the checked contract).
- Fat `utils.py`/`helpers.py`/`services.py` modules.

## 11. Architecture enforcement

`import-linter` in `pyproject.toml`:

```toml
[tool.importlinter]
root_package = "shop"
include_external_packages = true

[[tool.importlinter.contracts]]
name = "Domain is pure"
type = "forbidden"
source_modules = ["shop.orders.domain"]
forbidden_modules = [
  "shop.orders.application", "shop.orders.adapters", "shop.bootstrap",
  "fastapi", "flask", "django", "sqlalchemy", "pydantic", "httpx",
]

[[tool.importlinter.contracts]]
name = "Application does not depend on adapters"
type = "forbidden"
source_modules = ["shop.orders.application"]
forbidden_modules = ["shop.orders.adapters", "fastapi", "flask", "sqlalchemy"]

[[tool.importlinter.contracts]]
name = "Inbound and outbound adapters are independent"
type = "independence"
modules = ["shop.orders.adapters.inbound", "shop.orders.adapters.outbound"]
```

Run `lint-imports` in CI beside ruff, mypy and pytest.
