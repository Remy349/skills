# Recipe: <name>

<!-- Template for references/recipes/<name>.md. Code is framework-free: domain, ports, use case, fakes and tests only. -->

## Problem
One paragraph: the situation this recipe solves.

## Use it when / skip it when
- Use when: ...
- Skip when: ...

## Design
Short list of the moving parts (aggregate, ports, use case) and the rule that drives the design.

## Code
Domain → ports → use case, in plain language code with no framework imports.

## Tests
Use case tests with in-memory fakes covering the happy path and each expected failure.

## Wiring
Two or three lines on how the inbound adapter and outbound adapters connect; point to `../frameworks/` and `../persistence/` for the details.
