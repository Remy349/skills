# Contributing

## How the repository is organized

```text
shared/              single source of truth for content common to every language skill (not installed)
  core.md            principles, working modes, rules by layer, errors, transactions, anti-patterns
  checklist.md       final checklist
  ddd.md             strategic and tactical DDD
  rest-api.md        HTTP contract conventions
  solid-patterns.md  SOLID, design patterns, clean code
  testing-strategy.md
  templates/         shapes for new framework, persistence and recipe files
scripts/
  build.mjs          copies shared/ into the skills and fills generated regions
  validate.mjs       frontmatter, description length, SKILL.md size, broken links
skills/
  hexagonal-<language>/
    SKILL.md
    references/
      idioms.md            language conventions, layout, base PlaceOrder slice, architecture test
      testing.md           language test tooling
      frameworks/<fw>.md   inbound adapter + wiring for one framework
      persistence/<lib>.md outbound persistence adapter for one library
      recipes/<name>.md    framework-free use case recipes
      ddd.md, rest-api.md, solid-patterns.md, testing-strategy.md   (generated, do not edit)
evals/               prompts and expectations used to check the skills
```

Every skill must be self-contained: users install one folder, so a skill cannot reference files outside itself. That is why shared content is copied into each skill instead of linked.

## Editing shared content

1. Edit the file in `shared/`, never the generated copy inside a skill.
2. Run `node scripts/build.mjs`.
3. Commit the source and the regenerated files together.

Regions inside `SKILL.md` between `<!-- BEGIN GENERATED: shared/<file> -->` and `<!-- END GENERATED: shared/<file> -->` are overwritten by the build. Everything outside those markers is edited by hand.

CI runs `node scripts/build.mjs --check` and `node scripts/validate.mjs`; run `npm run check` locally before opening a pull request.

## Adding a framework, persistence library or recipe

Copy the matching file from `shared/templates/`, keep all its sections, and link the new file from the skill's `SKILL.md` detection table or reference index. Recipes must stay framework-free: domain, ports, use case, fakes and tests only.

## Adding a language

1. Create `skills/hexagonal-<language>/SKILL.md` using an existing language skill as the model, keeping the generated regions.
2. Write `references/idioms.md` and `references/testing.md`, then the framework, persistence and recipe files.
3. Run `node scripts/build.mjs` to copy the shared references, then `node scripts/validate.mjs`.
4. Add prompts to `evals/`, update the README tables.

## Code examples

Examples must compile or type-check with the versions the guide states. Prefer complete, small examples over fragments, and keep the same `PlaceOrder` domain across files so readers can combine them.
