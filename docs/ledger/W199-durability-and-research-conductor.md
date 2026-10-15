# W199: durability primitives and the research conductor (D1-D4)

Status: implemented, pending CI.

## Problem

The durability plan (`augur/docs/durability-plan.md`, approved 2026-10-15)
named three bounded pieces that the plane's existing primitives did not yet
cover, plus the orchestration they make durable. Two builds landed together
because D4 (the conductor checkpoint) is meaningful only against a conductor,
and the deep-research plan (`augur/docs/planning-questions.md`) sequences "build
the conductor first, then the checkpoint".

## What shipped

### D1 — step journal with idempotency keys

`src/integrations/step-journal.ts` (`DurableStepJournal`). A durable step is
explicit `(runId, stepId, attempt)` plus an input digest. `step()` invokes the
effect once and records the output; a replay with the same digest returns the
recorded output **without** re-invoking the effect; the same key with a
*different* digest throws `StepConflictError` (fail closed). Persistence rides
the same atomic temp+rename discipline as the schedule table.

### D2/D3 — durable timers on the existing tick

`src/integrations/durable-timers.ts` (`DurableTimer`, `DurableTimerTable`).
A wait that survives restart is a row with a `wakeAt`. `hub-scheduler.ts`
gained an optional `timers`/`resumeTimer` pair; `tick(now)` drains due timers
**before** cron evaluation, marks each fired only after its resume succeeds, and
leaves a failed resume unfired so the next tick retries. No second clock: `due()`
is deterministic and the caller owns the clock, matching the scheduler's "owns
no clocks in tests" discipline (`hub-scheduler.ts:11-13`).

### D4 — conductor checkpoint

`src/integrations/conductor-checkpoint.ts` (`ConductorCheckpointStore`).
Persists the plan, the dispatched `{stepId, artifactRef, status, digest}` rows,
and the cursor. It stores **references**, never subagent bodies or transcripts
(the artifact-handoff point is the shared `/workspace`). Resume skips completed
steps whose artifacts still verify by digest and re-dispatches the rest
(at-least-once, guarded by the D1 step key).

### Step 0 — the research conductor

`src/assistant/research/` (`types.ts`, `conductor.ts`, `prompt.ts`). The
orchestrator-worker split: the conductor plans and synthesizes (frontier tier,
few tokens); workers search and verify on the cheap tier (many tokens) and hand
back artifact references, not transcripts. Four cost controls from the plan:

- **Tier the roles**: model choice lives behind the injected ports; the
  conductor itself is provider-agnostic.
- **Effort scales to complexity**: `researchEffort()` returns `maxSubagents` /
  `maxToolCallsPerSubagent` per complexity, embedded in the plan prompt verbatim.
- **Artifacts, not transcripts**: `WorkerResult.body` goes to the `ArtifactStore`;
  only `artifactRef` plus an optional one-line `summary` reaches synthesis.
- **A budget breaker**: `ResearchBudget` caps subagents, tool calls, and spend;
  the conductor stops (does not silently continue) and reports `budgetExhausted`.

The conductor is a *library*, not a running service: it takes injected `plan`,
`runWorker`, and `synthesize` ports, so it holds no provider and no transport.
That keeps it inside the assistant's kernel-purity posture and makes every cost
control testable offline.

## Evidence

- `test/step-journal.test.ts` — D1: replay serves the record and the effect runs
  once; a key with a changed digest throws; a bumped attempt re-runs; disk
  round-trip; absent/corrupt file behavior.
- `test/durable-timers.test.ts` — D2: a persisted past-due timer fires once
  across a restart, `firedAt` recorded, no re-fire. D3: `now + 3h` survives a
  restart and fires only after `wakeAt` (the Q73 reboot case); a throwing resume
  retries; duplicate ids rejected.
- `test/conductor-checkpoint.test.ts` — idempotent dispatch, digest conflict,
  monotonic cursor, plan freeze after dispatch, disk round-trip.
- `test/research-conductor.test.ts` — **D4 acceptance**: 5 tasks, 2 complete,
  the process is "killed", resume skips the 2 (artifacts verify), runs 3-5, and
  the completed tasks are not re-spent; a missing artifact re-opens its task; the
  subagent and cost breakers stop the plan.
- `test/research-prompt.test.ts` — the effort bound and the artifact-not-transcript
  handoff are pinned in the prompts.

All five suites are registered in `test/ci-suites.txt` in sorted position. Local:
`tsc --noEmit` clean, `npm run build` clean, eslint clean on every changed file,
`ci-suites-manifest` / `assistant-isolation` / `kernel-purity` green, the 23 new
tests green, and `hub-scheduler` + `hub-scheduler-off-peak` + `hub-run-gates` +
`workflow-settings` (34 tests) green (the tick change is non-breaking).

## Scope decisions

- **D5 deferred.** Exactly-once delivery of an outside side effect is an
  application-level problem, and the notifier seam it needs is M7's `notify-mcp`
  gap (`integration-plan.md` §F item 4). The plan already sequences D5 there.
- **The conductor is provider-agnostic on purpose.** The Foundry provider class
  is gated on the operator's `gpt-6-sol` provisioning decision; this step lands
  without it and without any network call.
- **No engine, no new clock, no new database.** Temporal/DBOS/Restate/Durable
  Task Scheduler stay off the dependency graph, per the plan's non-goals.

## Follow-ups

- Wire the conductor's ports to the folded assistant's provider and to the
  `notify-mcp`/`deep_research` connectors once provisioning lands.
- The timer table's storage location and retention (plan §9 open questions) stay
  open; this slice persists alongside the schedule table only when a caller
  passes a `path`, and retains fired timers.
