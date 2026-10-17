# W216: a production entry point for the deep-research conductor

Status: implemented, pending review. Branch `feat/w216-research-entry-point`.

## Problem

The research conductor existed but had no production caller. `runResearch`
(`src/assistant/research/conductor.ts`) owns the plan → dispatch → synthesize
control flow and holds no transport. `openRouterConductorPorts`
(`src/assistant/research/openrouter-ports.ts`) binds the three ports to an
`OpenRouterProvider` but composes nothing durable. Nothing assembled the two
with a per-run directory, a durable checkpoint, and a derived budget; the
conductor was unreachable outside its own tests.

## Decision

- **The CLI subcommand is the single sanctioned bridge.** `augur research
  <question>` is the production caller. `src/cli/augur.ts` is the one module
  the plane permits to import `src/assistant/` (enforced by
  `test/assistant-isolation.test.ts`), so the composition lives there and the
  new `src/assistant/research/entry.ts` stays a pure, testable module under the
  assistant subtree. No hub route and no new plane module are added.
- **Deterministic run id ⇒ resume, not re-spend.** When `--run-id` is absent the
  id is `sha256(question).slice(0, 16)`. Re-running the same question resolves
  the same `<workspace>/research/<runId>` root and loads the existing
  `checkpoint.json`, so completed workers whose artifacts still verify are
  skipped and the frontier tier is not re-paid. An explicit `--run-id` is the
  escape hatch for a deliberate fresh run or a shared handle.
- **Foundry stays operator-gated.** The entry point takes an injected
  `OpenRouterProvider`; the eventual Foundry move replaces the provider binding
  in `openrouter-ports.ts`, not this composition. No Foundry code or credential
  path is added here.
- **Citation duty is met by worker-inline links.** The worker system prompt
  already instructs inline markdown citations, and the synthesis prompt cites
  only sources the workers retrieved. The entry point adds no separate
  references render pass.

## Files

- `src/assistant/research/entry.ts` (new): `ResearchRunOptions`,
  `ResearchRunResult`, `runResearchEntry`. Builds the file store, loads or
  creates the checkpoint, derives the budget from `researchBudget(complexity)`
  with `maxSubagents`/`maxCostUsd` overrides, binds the ports, runs the
  conductor, and writes `answer.md`. Exact-optional spreads throughout
  (`...(x === undefined ? {} : { k: x })`).
- `src/cli/augur.ts`: the `research` subcommand, `cmdResearch`, `requireComplexity`,
  `optionalNumber`, the four new `parseArgs` options
  (`complexity`, `max-cost-usd`, `max-subagents`, `run-id`), and the USAGE
  lines/options/examples.
- `test/research-entry.test.ts` (new): a real offline end-to-end through a fake
  `fetchImpl` that roles the reply by request body (plan / worker / synthesize).
- `test/ci-suites.txt`: `test/research-entry.test.ts` added in sorted position.
- `docs/FEATURES.md`: the honest Partial status row.

## Gate evidence

- `npm run lint` — clean (exit 0).
- `npm run typecheck` — clean (exit 0).
- `npm run build` — clean (exit 0).
- `node --import tsx --test test/research-entry.test.ts` — 3 pass, 0 fail.
- `node --import tsx --test test/research-conductor.test.ts
  test/research-openrouter-ports.test.ts test/ci-suites-manifest.test.ts
  test/assistant-isolation.test.ts` — 13 pass, 0 fail.

The entry-point test asserts: `answer.md` holds the synthesized text; worker
artifacts land under `<root>/findings/`; `checkpoint.json` records both
dispatches with digests; a second run on the same run id/root reports both
steps `skipped` and issues ZERO new worker calls (while still synthesizing);
and a seeded 2-task plan under `maxSubagents: 1` reports
`budgetExhausted === true` after exactly one worker.

## Honest residuals

- **No Foundry.** The lane is OpenRouter-only (direct key or the assistant
  gateway front door). The Foundry provider and its provisioning remain
  operator-gated.
- **No hub route, no scheduler wiring.** The conductor is reachable from a
  scheduled/RSI turn only because that turn can run `augur research`; there is
  no first-class hub endpoint.
- **The dollar breaker is off by default.** `openRouterConductorPorts` prices no
  call (`estimateCostUsd` defaults to zero), so `maxCostUsd` only bites once a
  host supplies prices; the subagent and tool-call caps are the always-on
  breakers. `--max-cost-usd` sets the ceiling but does not create a pricer.
