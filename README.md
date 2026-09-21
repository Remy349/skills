# skills

A collection of reusable [agent skills](https://www.skills.sh/docs) for AI coding assistants.

Skills are folders of instructions that an agent loads on demand. Instead of re-explaining your conventions in every prompt, you install a skill once and the agent applies it whenever the task matches.

## Available skills

| Skill | Description |
|---|---|
| [`hexagonal-backend`](skills/hexagonal-backend) | Design, implement, review and refactor REST APIs with hexagonal architecture (ports & adapters), with idiomatic practices for Python, Go, TypeScript, Java and C#. |

## Installation

Requires Node.js. Run from your project directory (or see the CLI docs for global installs).

```bash
# npm
npx skills add Remy349/skills

# pnpm
pnpm dlx skills add Remy349/skills
```

The [`skills` CLI](https://www.skills.sh/docs/cli) will let you pick the skill and the agents to install it for.

To pull later changes:

```bash
npx skills update
```

Run `npx skills add --help` to see the options available in your CLI version, such as installing a single skill or targeting a specific agent.

## Compatibility

The skills follow the open `SKILL.md` format, so they work with any agent supported by the `skills` CLI, including Claude Code, Cursor, Codex, GitHub Copilot, Windsurf, Gemini, Cline and OpenCode.

| Agent | Status |
|---|---|
| OpenCode | Tested |
| Other agents | Expected to work through the CLI, not tested yet |

## `hexagonal-backend`

### Purpose

Keep business rules independent from frameworks, transport and persistence. This skill guides the agent to build and review server-side code so that the domain and use cases can be tested without a database or a web server, and so infrastructure can be swapped without rewriting the rules.

### What it does

- **Detects your stack** from the repository (`go.mod`, `pom.xml`, `*.csproj`, `pyproject.toml`, `package.json` + `tsconfig.json`) and loads the matching language guide.
- **Follows the codebase first.** It respects existing formatters, linters, folder layout and naming before applying its own defaults.
- **Scales the architecture to the problem.** Thin slices for plain CRUD, full hexagonal structure for features with real business rules, events and outbox only where needed. No layers without a reason.
- **Guides feature-by-feature construction**: domain, outbound ports, use case, inbound REST adapter, outbound adapters, composition root, tests.
- **Applies REST best practices**: resource modeling, status codes, Problem Details errors (RFC 9457), pagination, idempotency, optimistic concurrency and security basics.
- **Covers SOLID, design patterns and clean code**, with guidance on when *not* to use each pattern.
- **Defines a testing strategy per boundary**: domain tests, use cases with in-memory fakes, port contract tests, HTTP adapter tests, integration tests with containers.
- **Enforces the dependency rule automatically** with architecture tests and linters.
- **Supports migrations of legacy code** through the strangler approach and characterization tests.

### Supported languages

| Language | Frameworks covered | Architecture enforcement |
|---|---|---|
| TypeScript | Express, Fastify, NestJS | dependency-cruiser |
| Python | FastAPI, Flask, Django | import-linter |
| Go | `net/http`, chi | depguard |
| Java | Spring Boot | ArchUnit |
| C# | ASP.NET Core | NetArchTest |

Each language guide includes naming and style conventions, project layout, a complete vertical slice (`PlaceOrder`), error mapping, testing tools and common pitfalls.

### How to use it

Once installed, the agent activates the skill automatically when your request matches it. You can also name it explicitly. Example prompts:

```text
Structure a new orders REST API in Go using ports and adapters.
```

```text
Refactor this fat NestJS controller into a use case with a repository port.
```

```text
Review this Spring Boot service for architecture and SOLID problems.
```

```text
Add a PayOrder use case to this FastAPI project following the existing layout.
```

```text
Use the hexagonal-backend skill to decouple this service from its database.
```

### Skill contents

```text
skills/hexagonal-backend/
├── SKILL.md                      # workflow and language-agnostic rules
└── references/
    ├── typescript.md
    ├── python.md
    ├── go.md
    ├── java.md
    ├── csharp.md
    ├── rest-api.md               # HTTP contract, errors, pagination, security
    ├── design-patterns-solid.md  # SOLID, patterns, DDD basics, clean code
    └── testing.md                # testing strategy per boundary
```

Language guides are loaded only when needed, so the skill keeps its context footprint small.

## Repository structure

```text
skills/
├── README.md
├── LICENSE
└── skills/
    └── <skill-name>/
        ├── SKILL.md
        └── references/
```

## Contributing

Issues and suggestions are welcome. If a skill gives wrong guidance for your language or framework, open an issue with the prompt you used and the output you expected.

## License

[MIT](LICENSE)
