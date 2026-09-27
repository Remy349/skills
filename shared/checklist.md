## Final checklist

- [ ] Domain and application import no framework, ORM, HTTP or SDK types (an architecture test enforces it).
- [ ] The bounded context and subdomain type are clear, and the depth matches the proportionality table.
- [ ] Aggregates protect their invariants; value objects replace primitives that carry rules.
- [ ] Every external dependency sits behind an outbound port named for a capability.
- [ ] Each use case has explicit input/output types and one responsibility.
- [ ] Adapters map to and from the domain and never leak persistence or vendor models into the API.
- [ ] Request shape validated at the edge; business invariants enforced in the domain or use case.
- [ ] Errors translated once at the inbound edge, with stable codes and correct statuses.
- [ ] Transaction boundary at the use case; no remote call assumed atomic with the database.
- [ ] Wiring is explicit in a composition root; configuration validated at startup; graceful shutdown handled.
- [ ] Naming, formatting and tooling follow the language conventions and the project's existing configuration.
- [ ] Tests exist per boundary; use cases tested with fakes; formatter, linter, type checker and tests were run and their result reported.
- [ ] No abstraction was added without a nameable reason.
