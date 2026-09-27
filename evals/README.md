# Evals

Prompts and expectations used to check that each skill triggers when it should and produces code that follows its rules. There is no automated runner yet: run a prompt with the skill installed, then grade the output against the expectations.

## Files

| File | What it checks |
|---|---|
| `triggering.json` | Which prompts must load which skill, and which must load none |
| `hexagonal-python.json` | Output quality for the Python skill |
| `hexagonal-typescript.json` | Output quality for the TypeScript skill |
| `hexagonal-go.json` | Output quality for the Go skill |

## Format

```json
{
  "skill": "hexagonal-python",
  "evals": [
    {
      "id": "short-kebab-id",
      "prompt": "What the user types",
      "setup": "Optional: repository state before the prompt",
      "expectations": ["Verifiable statements about the output"]
    }
  ]
}
```

Write expectations that a reviewer (human or model) can check by reading the output or running a command: "the domain module imports nothing from fastapi", not "the code is clean".

## How to run one manually

1. Create an empty project or check out the fixture described in `setup`.
2. Install only the skill under test: `npx skills add Remy349/skills --skill <name> --agent <agent>`.
3. Paste the prompt into the agent.
4. Grade each expectation as pass or fail, and record the agent, model and skill commit.

When a skill changes, rerun its evals and the triggering set before merging.
