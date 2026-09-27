# skills

A collection of reusable [agent skills](https://www.skills.sh/docs) for AI coding assistants.

Skills are folders of instructions that an agent loads on demand. Instead of re-explaining your conventions in every prompt, you install a skill once and the agent applies it whenever the task matches.

## Available skills

| Skill | Language | Frameworks | Persistence | Tests |
|---|---|---|---|---|
| [`hexagonal-python`](skills/hexagonal-python) | Python 3.11+ | FastAPI, Flask | SQLAlchemy 2 | pytest, import-linter |
| [`hexagonal-typescript`](skills/hexagonal-typescript) | TypeScript on Node.js | NestJS, Express, Fastify | Prisma, TypeORM, Drizzle | Vitest, dependency-cruiser |
| [`hexagonal-go`](skills/hexagonal-go) | Go 1.26+ | net/http, chi, Gin, Echo, Fiber | pgx, sqlc, GORM | testing, testcontainers-go, golangci-lint (depguard) |

Supported languages are **Python, TypeScript and Go**. Java, C# and PHP are not supported: the previous multi-language `hexagonal-backend` skill has been removed (see [Migrating from hexagonal-backend](#migrating-from-hexagonal-backend)).

## What the hexagonal skills do

Each `hexagonal-<language>` skill guides the agent to design, build, review and refactor backend REST APIs with **Hexagonal Architecture (Ports and Adapters)** and **Domain-Driven Design**, so business rules stay independent of the web framework, the ORM and every external system.

- **Framework-agnostic core.** Domain and use cases are plain language code. Frameworks and ORMs live only in adapters, each with its own guide, and there is a procedure for frameworks without one.
- **DDD, strategic and tactical.** Subdomains decide how much architecture a feature gets; bounded contexts, context mapping (Anti-Corruption Layer and friends), aggregates, value objects and domain events.
- **Proportionality.** Thin slices for CRUD, full hexagonal for real business rules, outbox and read models only where needed. No layer without a reason.
- **Three working modes.** BUILD (feature by feature, inside-out), REVIEW (findings by severity with file, rule, consequence and smallest fix), MIGRATE (strangler approach with characterization tests).
- **Recipes** for the recurring cases, written framework-free: CRUD thin slice, aggregate state machine with optimistic concurrency, external API behind an ACL, domain events with the transactional outbox, read model with cursor pagination, idempotent commands.
- **REST, SOLID, patterns and clean code**, including when *not* to use a pattern.
- **Testing per boundary** with fakes, shared contract suites for every adapter, and integration tests against real PostgreSQL in containers.
- **Automatic architecture enforcement** in CI (import-linter, dependency-cruiser, golangci-lint with depguard).

Every code example in these skills is extracted from the Markdown and verified: type-checked in strict mode, linted, and run, including integration tests against PostgreSQL through Testcontainers.

## Installation

Requires Node.js. Run from your project directory. Install the skill for the language of your backend:

```bash
# Python backend
npx skills add Remy349/skills --skill hexagonal-python

# TypeScript / Node.js backend
npx skills add Remy349/skills --skill hexagonal-typescript

# Go backend
npx skills add Remy349/skills --skill hexagonal-go

# Monorepo with several backends
npx skills add Remy349/skills --skill hexagonal-python hexagonal-go
```

With pnpm, use `pnpm dlx skills add ...` instead of `npx skills add ...`.

Useful options of the [`skills` CLI](https://www.skills.sh/docs/cli):

| Option | Effect |
|---|---|
| `--list` | Show the skills available in this repository without installing |
| `--agent claude-code opencode` | Install for specific agents only (`'*'` for all) |
| `-g` | Install at user level instead of in the project |
| `--copy` | Copy files instead of symlinking them into each agent's folder |
| `-y` | Skip the confirmation prompts |

Running `npx skills add Remy349/skills` without `--skill` opens an interactive picker.

The CLI records what you installed in `skills-lock.json`. Commit it so everyone on the team gets the same skills. To update later:

```bash
npx skills update hexagonal-python
```

Run `npx skills add --help` to see the options of your CLI version.

## Migrating from hexagonal-backend

The old multi-language `hexagonal-backend` skill no longer exists. Replace it with the skill for your language:

```bash
npx skills remove hexagonal-backend
npx skills add Remy349/skills --skill hexagonal-go      # or hexagonal-python, hexagonal-typescript
```

Having both installed makes them compete for the same prompts, so remove the old one. For Java and C# there is no replacement.

## Compatibility

The skills follow the open `SKILL.md` format, so they work with any agent supported by the `skills` CLI, including Claude Code, Cursor, Codex, GitHub Copilot, Windsurf, Gemini, Cline and OpenCode.

| Agent | Status |
|---|---|
| OpenCode | Tested |
| Other agents | Expected to work through the CLI, not tested yet |

## How to use them

Once installed, the agent activates the skill when your request matches it. You can also name it explicitly. Example prompts:

```text
Structure a new orders REST API with FastAPI using ports and adapters.
```

```text
Refactor this fat NestJS service into use cases with repository ports.
```

```text
Review this Express + Prisma project for architecture and SOLID problems.
```

```text
Split this Gin handler that runs SQL into a use case with a repository port.
```

```text
Add a CancelOrder use case with optimistic concurrency to this Flask project.
```

```text
We lose events when the broker is down. Publish OrderPlaced reliably.
```

## Skill contents

Every language skill has the same shape, so what you learn in one applies to the others:

```text
skills/hexagonal-<language>/
├── SKILL.md                    # detection, working modes, core rules, language essentials, checklist
└── references/
    ├── idioms.md               # conventions, layout, base vertical slice, architecture enforcement
    ├── testing.md              # test tooling for the language
    ├── frameworks/<fw>.md      # one guide per web framework
    ├── persistence/<lib>.md    # one guide per ORM or query builder
    ├── recipes/<case>.md       # framework-free recipes for recurring use cases
    ├── ddd.md                  # strategic and tactical DDD
    ├── rest-api.md             # HTTP contract, Problem Details, pagination, security
    ├── solid-patterns.md       # SOLID, design patterns, clean code
    └── testing-strategy.md     # what to test at each boundary
```

The agent loads `SKILL.md` first and reads references only when the task needs them, which keeps the context small.

## Repository structure

```text
skills/                         # this repository
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── shared/                     # single source of truth for content common to every language skill
├── scripts/
│   ├── build.mjs               # copies shared/ into the skills
│   └── validate.mjs            # frontmatter, description length, size, links
├── evals/                      # prompts and expectations to check the skills
└── skills/
    └── hexagonal-<language>/
```

`shared/` is not installed: the CLI only picks up folders that contain a `SKILL.md`. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the shared content is generated into each skill.

## Contributing

Issues and suggestions are welcome. If a skill gives wrong guidance for your language or framework, open an issue with the prompt you used and the output you expected. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing a skill.

## License

[MIT](LICENSE)
