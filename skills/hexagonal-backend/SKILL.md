---
name: hexagonal-backend
description: Design, implement, review and refactor backend REST APIs using Hexagonal Architecture (Ports and Adapters), language-agnostic, with idiomatic best practices for Python, Go, TypeScript/Node, Java and C#/.NET. Covers use cases, domain modeling, ports, inbound/outbound adapters, composition root, error handling, REST conventions, SOLID, design patterns, clean code and testing per boundary. Use this skill whenever the user works on server-side code and mentions hexagonal, ports and adapters, clean architecture, layers, use cases, repositories, controllers, services, decoupling from a framework or database, structuring a new API, refactoring a "fat controller" or tightly coupled service, or asks how to organize a backend project, even if they never say "hexagonal". Also use it when reviewing backend code for architecture, SOLID or testability problems.
---

# Hexagonal Backend (Ports & Adapters) for REST APIs

The goal of this architecture is one thing: **business rules must not know how they are delivered (HTTP, CLI, queue) or stored (SQL, API, files)**. That single property is what makes the code testable without infrastructure, lets you swap a database or framework without rewriting rules, and keeps a change in one edge from rippling through the system.

This skill is language-agnostic. The principles below are the same everywhere; how they are spelled (naming, error handling, wiring, tooling) is not. So the workflow starts by detecting the language and then loading that language's reference file.

## How to use this skill

1. **Detect the stack** (Step 0 below) and read `references/<language>.md`. Do this before writing any code, because idioms differ a lot (Go has no exceptions and prefers consumer-defined interfaces; Python uses `Protocol`; Spring and ASP.NET have their own DI conventions).
2. **Detect the project state**: greenfield, already hexagonal, layered/legacy, or framework-coupled. Adapt the plan (see "Migrating existing code").
3. **Choose the depth** with the proportionality rule below. Not every endpoint deserves every layer.
4. **Build feature by feature** with the workflow in "Building a feature".
5. **Consult the other references** when the task touches them:
   - `references/rest-api.md`: HTTP contract, status codes, error format, pagination, idempotency, security basics.
   - `references/design-patterns-solid.md`: SOLID applied to this architecture, patterns and when to use them, DDD tactical basics, clean code rules.
   - `references/testing.md`: what to test at each boundary, fakes vs mocks, contract tests, architecture tests.
6. **Verify** with the checklist at the end before declaring the work done.

## Step 0: Detect the language and conventions

Look at the repository, not at assumptions. Use the first match; in a polyglot monorepo apply the skill per service.

| Marker files | Language | Read |
|---|---|---|
| `package.json` + `tsconfig.json` (or `.ts` sources) | TypeScript / Node | `references/typescript.md` |
| `pyproject.toml`, `requirements*.txt`, `setup.py`, `Pipfile` | Python | `references/python.md` |
| `go.mod` | Go | `references/go.md` |
| `pom.xml`, `build.gradle`, `build.gradle.kts` (Java sources) | Java | `references/java.md` |
| `*.csproj`, `*.sln`, `global.json` | C# / .NET | `references/csharp.md` |

Then detect the **framework** from dependencies (NestJS, Express, Fastify, FastAPI, Flask, Django, `net/http`, chi, gin, Spring Boot, Quarkus, ASP.NET Core) and the **existing conventions**: formatter and linter configs, test framework, folder layout, naming, error style, DI approach.

**Match the codebase first, this skill's defaults second.** If the project already uses `snake_case` filenames, a specific test runner or a given folder scheme, keep them. Introduce a new convention only when the user asks for it or the existing one is clearly broken.

If nothing can be detected (empty directory, no hint in the request), ask which language and framework to use, in one short question. If the language is outside the five covered (Kotlin, Rust, PHP, Ruby...), apply the principles in this file and translate idioms carefully, saying that no dedicated reference exists.

## Proportionality: how much architecture?

Every abstraction has a cost in files, indirection and reading time. Add a layer or port only when you can name the pain it removes: swapping infrastructure, testing without it, isolating an external system you do not control, or protecting real business rules from churn.

| Situation | Depth |
|---|---|
| Pure CRUD, no business rules, one storage | **Thin slice**: route/controller → use case (or thin service) → repository port + adapter. Skip a rich domain model; a plain data type is fine. Still keep SQL and HTTP types out of the use case. |
| Feature with real rules, state transitions, several collaborators | **Full hexagonal** (default): domain model + use case + ports + adapters + composition. |
| Cross-service consistency, audit, high write/read asymmetry | Add **domain events, outbox, or CQRS read models** for that feature only. |

Do not create a port for something that is stable, owned by the language standard library and never faked (e.g. string formatting). Do create one for the clock, ID generation and randomness when tests need determinism. Do not create `Impl`-only interfaces with a single implementation and no boundary reason.

## Core model

Dependencies point **inward**. Nothing in the inner layers imports anything from the outer ones.

```
 Inbound adapters ──► Application (use cases) ──► Domain
 (HTTP, CLI, queue)          │
                             ▼ depends on (interfaces owned by application)
                      Outbound ports ◄── Outbound adapters (DB, HTTP clients, brokers)

 Composition root: the only place that knows concrete adapters and wires them.
```

| Layer | Responsibility | May depend on | Must NOT depend on |
|---|---|---|---|
| **Domain** | Entities, value objects, invariants, domain services, domain errors | The language standard library only | Frameworks, ORM, HTTP, JSON/serialization libs, SDKs, DI containers |
| **Application** | Use cases: orchestrate domain + ports, transaction boundary, input/output DTOs, application errors | Domain, its own port interfaces | Web framework types, ORM types, concrete adapters |
| **Inbound adapters** | Translate protocol → use case input and result/error → protocol (HTTP routes, CLI, consumers, schedulers) | Application (use case contracts), framework | Outbound adapters, persistence details |
| **Outbound adapters** | Implement outbound ports with a technology (SQL repo, payment SDK wrapper, S3, SMTP) | Application ports, domain types, libraries | Inbound adapters, other adapters directly |
| **Composition root** | Build adapters, inject into use cases, start the server, load config | Everything | Nothing depends on it |

Ports model **capabilities, not technologies**: `OrderRepository`, `PaymentGateway`, `Clock`, `EventPublisher`, never `PostgresService` or `StripeClient`. Outbound ports live in the application layer (they express what the use case needs). Inbound ports are the use case contracts themselves: an interface when several adapters or a decorator need to share it, or simply the use case class/function when there is only one caller.

## Project layout

Organize **by feature first, then by layer**. This keeps a change local and lets you delete a feature cleanly. Adapt the shape to the language (see the reference; Go, Java and .NET each have a natural variant).

```
<service>/
  features/ (or modules/, internal/)
    orders/
      domain/          # entities, value objects, domain errors, policies
      application/     # use cases, ports (in/out), DTOs
      adapters/
        inbound/http/  # routes/controllers, request/response DTOs, error mapping
        outbound/persistence/   # repository implementations, persistence models, mappers
        outbound/<gateway>/     # payment, email, storage...
      composition/     # wiring for this feature (or a module/container file)
  shared/              # tiny, pure, stable helpers only. Not a dumping ground.
  bootstrap/           # main entry, config loading, server start, global wiring, health
```

Naming folders after the layer they represent (`domain`, `application`, `adapters`) beats naming them after technologies. Never create `utils`, `common`, `helpers` or `manager` buckets for business logic.

## Building a feature: workflow

Work inside-out and test as you go. This order gives fast feedback because the core needs no infrastructure.

1. **State the use case in words.** Actor, input, output, business rules, side effects, expected failures. One use case = one verb (`PlaceOrder`, `CancelOrder`), not a `OrderService` with fifteen methods.
2. **Model the domain.** Entities and value objects with invariants enforced at construction. Return new values rather than mutating shared state where the language makes that natural. Raise/return domain errors for rule violations.
3. **Define outbound ports** from the use case's point of view: only the methods it needs, with domain types in and out. Add `Clock`/`IdGenerator` if time or IDs matter to behavior.
4. **Write the use case.** It receives its ports through the constructor (or parameters), takes a plain input DTO, returns a plain output DTO, and contains orchestration, not HTTP and not SQL. Decide the transaction boundary here.
5. **Test the use case with in-memory fakes** of the ports before any adapter exists (see `references/testing.md`).
6. **Write the inbound adapter.** Parse and validate the request shape, map to the input DTO, call the use case, map the result or error to the HTTP response. Nothing else.
7. **Write the outbound adapters.** Map between domain and persistence/wire models inside the adapter. Translate infrastructure errors into application errors.
8. **Wire in the composition root.** Explicit construction, no hidden globals or service locators.
9. **Add adapter integration tests** (real DB via containers, HTTP-level tests for the inbound adapter) and a few end-to-end journeys.

## Rules by layer

**Domain**
- Enforce invariants in constructors/factories so an invalid object cannot exist. Separate "create new" from "rehydrate from storage" (rehydration skips creation rules).
- Model money, ids, emails and quantities as value types or at least dedicated aliases; avoid primitive obsession. Never use binary floating point for money; use integer minor units or a decimal type.
- Keep behavior with the data that owns it (tell, don't ask). If a rule needs two aggregates or an external lookup, it belongs in a domain service or in the use case, not in a random entity.
- No annotations, decorators or tags for frameworks. Persistence and JSON mapping belong in adapters.

**Application**
- One public entry point per use case. Input and output are plain, serialization-agnostic DTOs (records, dataclasses, structs, interfaces).
- Validate **business/application invariants** here; validate **request shape** (types, required, ranges, formats) in the inbound adapter. Both layers validate, for different reasons.
- Depend on port interfaces only. Never import an ORM session, an HTTP client, a request object or a framework logger type.
- Do not return persistence models. Do not leak adapter exceptions; expect application/domain errors from ports.
- Keep use cases free of `if provider == "stripe"` style branching; that is a Strategy or a different adapter.

**Inbound adapters (REST)**
- Thin. No business rules, no SQL, no calls to other adapters. If a controller has an `if` that encodes a business decision, move it inward.
- Own the request/response DTOs and the mapping to/from use case DTOs. Never expose domain entities or persistence models directly in responses; the API contract must evolve independently.
- Translate errors in **one central place** (exception handler/middleware/error mapper), not with try/catch in every route. See `references/rest-api.md`.
- Authentication, request IDs, rate limiting, CORS and body size limits are adapter/middleware concerns.

**Outbound adapters**
- Implement exactly one port each (or a cohesive small set). Map to and from the domain inside the adapter.
- Own the retries, timeouts, circuit breaking, pagination of external APIs, SQL and schema. Set timeouts on every network call.
- Convert technology errors (unique violation, timeout, 404 from a vendor) into the application's error vocabulary; keep the original as the cause for logs.

**Composition root**
- Single, explicit, auditable. Load and validate configuration at startup and fail fast. Inject configuration values, do not read environment variables deep inside adapters or use cases.
- Handle graceful shutdown (stop accepting requests, finish in-flight work, close pools).

## Error model

Three families, mapped once at the inbound edge:

| Family | Examples | Typical HTTP |
|---|---|---|
| **Validation** (request shape) | missing field, wrong type, out of range | 400 (or 422) |
| **Business/domain** (expected outcomes) | insufficient stock, order already paid, not found, conflict | 404, 409, 422 |
| **Infrastructure/unexpected** | DB down, upstream timeout, bug | 500/502/503/504 (generic message, details only in logs) |

Domain and application code must not know status codes. Give errors a stable machine-readable `code` (`ORDER_ALREADY_PAID`) so clients do not parse messages. Use the language's idiom (exceptions in Python/Java/C#/TypeScript, error values in Go) and stay consistent across the codebase. Never swallow errors silently and never log-and-rethrow the same error at every layer (log once, at the edge that handles it).

## Transactions and consistency

- The transaction boundary is the **use case**. Implement it with a Unit of Work port, a decorator around the use case, or the framework's declarative transaction at the application-service boundary (a conscious, documented trade-off if it adds a framework annotation to the application layer).
- One aggregate modified per transaction; reference other aggregates by id.
- Never call a remote system inside a DB transaction and assume atomicity. To publish events or call another service reliably, use the **outbox pattern**: write the event in the same transaction, publish asynchronously.
- Make retried operations safe: idempotency keys for non-idempotent POSTs, optimistic concurrency (version/ETag) for updates.

## Cross-cutting concerns

- **Logging**: structured, with a correlation/request id. A logger port is optional; using the ecosystem's standard logger through a thin wrapper is fine. Never log secrets or full PII.
- **Configuration**: typed, validated at startup, injected.
- **Time and IDs**: inject a clock and an id generator where behavior or tests depend on them.
- **AuthN/AuthZ**: authenticate in an inbound adapter/middleware and pass an authenticated principal (plain data) to the use case; enforce business permissions in the use case or a domain policy, not only in the route.
- **Observability**: health/readiness endpoints, metrics and tracing wired in adapters or decorators, not inside domain logic.

## SOLID, patterns, clean code (summary)

Details, smells and examples are in `references/design-patterns-solid.md`. In short:

- **S**: one reason to change per class; one use case per class/function.
- **O**: add behavior by adding an adapter or strategy, not by editing a growing `switch`.
- **L**: every adapter must honor its port's contract (same errors, same null/empty semantics); verify with shared contract tests.
- **I**: small, role-specific ports (`OrderReader` / `OrderWriter` if consumers differ), not one god repository.
- **D**: use cases depend on abstractions they own; concrete adapters are injected from outside.
- Prefer composition over inheritance, keep functions short and named for intent, avoid flags and boolean parameters, use early returns, avoid magic numbers, comment the *why*.
- Reach for a pattern to solve a present problem, not to decorate. Rule of three before abstracting duplication.

## Testing (summary)

Test each boundary with the cheapest tool that proves it: pure domain tests, use case tests with in-memory fakes, contract tests shared by every adapter of a port, inbound adapter tests at the HTTP level, integration tests against real infrastructure in containers, and a small number of end-to-end journeys. Prefer fakes over mocks; mock only your own ports, never third-party types (wrap them in a port first). See `references/testing.md`.

## Enforce the architecture automatically

Conventions decay unless a tool checks them. Add one rule set to CI that fails when the domain imports a framework or an adapter imports another adapter:

| Language | Tool |
|---|---|
| TypeScript | `dependency-cruiser` or `eslint-plugin-boundaries` |
| Python | `import-linter` |
| Go | `depguard` (golangci-lint), `go-arch-lint`, or a test with `go list -deps` |
| Java | ArchUnit |
| C# | NetArchTest / ArchUnitNET, plus project references |

## Migrating existing code

Never rewrite big-bang. Use the strangler approach:

1. Pick one vertical slice with high change pain and low blast radius (one endpoint or job).
2. Write **characterization tests** that pin current behavior.
3. Extract a use case with explicit input/output types. Have the old controller/service delegate to it.
4. Put existing infrastructure calls behind outbound ports (wrap the legacy code as the first adapter).
5. Move orchestration and rules inward; replace internals of the adapter later.
6. Keep a reversible switch (route or flag) until the new path is verified. Repeat slice by slice.

## Anti-patterns to flag and fix

- Domain entities importing ORM models, web framework types or SDK clients; ORM entities used as domain objects and API responses at once.
- Controllers containing business rules, transactions or SQL; use cases reading from `req`, `res` or queue metadata.
- Adapters calling each other directly instead of going through the application layer.
- Anemic domain plus a giant `*Service` with every method; "manager", "helper", "util" classes.
- Hidden global singletons, service locators, static access to the DB or config.
- Ports shaped like the vendor SDK (leaky abstraction) or one interface per class "just in case".
- Mapping layers with no boundary purpose (DTO copies of DTOs across the same layer).
- Catching a generic exception and returning 200 or an empty result; leaking stack traces to clients.
- Tests that need a running database to verify a business rule.

## Working style when generating code

- Produce idiomatic code for the detected language, following its official style guide and the project's formatter/linter config. Name files, types and functions the way that ecosystem does (details in the reference).
- Create only what the task needs (proportionality). Explain the reasoning for any port or layer you add in one or two sentences, not an essay.
- Show the smallest complete vertical slice first (domain → use case → adapter → wiring → test) so the user can see the shape, then extend.
- Run the formatter, linter, type checker and tests when tools are available, and report the result. Do not claim tests pass without running them.
- When reviewing, cite the exact file and rule broken, explain the consequence, and propose the smallest fix.

## Final checklist

- [ ] Domain and application import no framework, ORM, HTTP, or SDK types.
- [ ] Every external dependency is behind an outbound port named for a capability.
- [ ] Each use case has explicit input/output types and one clear responsibility.
- [ ] Adapters map to/from domain and never leak persistence or vendor models into the API.
- [ ] Request shape validated at the edge; business invariants enforced in the domain/use case.
- [ ] Errors translated once at the inbound edge with stable codes and correct statuses.
- [ ] Transaction boundary defined at the use case; no remote calls assumed atomic with the DB.
- [ ] Wiring is explicit in a composition root; config validated at startup; graceful shutdown handled.
- [ ] Naming, formatting and tooling follow the language's conventions and the project's existing config.
- [ ] Tests exist per boundary; use cases are tested with fakes; an architecture test guards the dependency rule.
- [ ] No abstraction was added without a nameable reason.
