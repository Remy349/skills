# <Library> persistence adapter guide

<!-- Template for references/persistence/<library>.md. -->

Scope: versions and the pattern the library follows (Active Record or Data Mapper) and what that implies.

## 1. Detection
## 2. Persistence model vs domain model
Where persistence models live, and explicit mapping functions (`to_domain` / `to_persistence`, or `rehydrate`).
## 3. Repository adapter
The `OrderRepository` port implemented with this library.
## 4. Unit of Work and transactions
## 5. Error translation
Unique violation → conflict error, not found, connection errors; keep the cause.
## 6. Optimistic concurrency
## 7. Migrations
## 8. Integration tests
Real database in a container, real migrations, isolation per test, the shared port contract suite.
## 9. Pitfalls
