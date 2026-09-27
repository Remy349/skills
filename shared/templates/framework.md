# <Framework> adapter guide

<!-- Template for references/frameworks/<framework>.md. Keep every section; write "n/a" when one does not apply. -->

Scope: which versions this guide targets and what it covers (inbound adapter, wiring, testing). The domain and use cases are the ones from `../idioms.md`; nothing here changes them.

## 1. Detection
Dependency names and version markers that identify the framework in the project.

## 2. Where each framework piece goes
| Framework piece | Hexagonal role | Notes |
|---|---|---|
| Router / controller | Inbound adapter | |
| Request validation | Inbound adapter (edge) | |
| Error handler | Inbound adapter (central error mapping) | |
| DI container / app factory | Composition root | |
| Lifecycle hooks | Composition root (bootstrap) | |

## 3. Inbound adapter
The `PlaceOrder` endpoint: request DTO, validation, mapping to the use case input, response DTO, `201` + `Location`.

## 4. Central error mapping
Domain/application errors and validation errors → Problem Details, registered once.

## 5. Composition root and dependency injection
How use cases receive their ports; where the framework's DI is allowed and where it is not.

## 6. Transactions and request-scoped resources
How to open a unit of work per request without leaking the framework into the application layer.

## 7. Testing the adapter
In-process test client, overriding the use case or its ports with fakes.

## 8. Pitfalls
Framework-specific ways the dependency rule usually breaks, each with its fix.
