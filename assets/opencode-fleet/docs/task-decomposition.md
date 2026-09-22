# Task Decomposition — Routing Work to Cheaper Models

> Pattern: a strong model plans and decomposes; cheap models execute
> well-specified subtasks; deterministic verification gates acceptance.
> In RSI terms this is **strong-to-weak capability transfer**: the expensive
> model's output (the task spec) is the harness the cheap model runs in.
> Sources: `reading-list.md` → Cost-tiered execution.

## When a subtask is cheap-model-ready

Route a subtask to a cheap model only when ALL of the following hold:

1. **Explicit inputs** — exact files/lines/symbols named; no discovery
   required.
2. **Executable acceptance check** — a command that decides done/not-done
   (test, typecheck, lint, script), not a judgment call.
3. **Bounded scope** — one file or one function; no cross-cutting design
   decisions.
4. **No taste required** — no naming, API-shape, or architecture choices;
   the pattern to follow is cited (a canonical example file).
5. **Cheap failure** — a wrong attempt is caught by the check, not silently
   merged.

If any of these fail, either fix the task spec until it is ready, or keep
the work on the strong model. The failure research is consistent here: a
9B-class model can *produce* harness-quality edits when the structure is
given, but *judging* and *integrating* still need capability.

## The routing loop

1. **Decompose (strong model).** Split the task; for each subtask write a
   spec: goal, inputs, constraints, acceptance command, escalation trigger.
2. **Route (cheap models).** Execute ready subtasks — in parallel worktrees
   when they touch overlapping files, so cheap parallelism can't corrupt
   each other.
3. **Verify (deterministic).** Run the acceptance command. Cheap models do
   not self-certify.
4. **Escalate on failure.** N cheap retries max (usually 2); then hand the
   failure trace to the strong model. It either fixes the subtask spec
   (it was underspecified — that's a decomposition bug, log it) or does the
   work directly.
5. **Integrate (strong model).** Review the merged diff as a whole. The
   decomposer owns cross-subtask coherence; subtask-level "passes its
   check" never implies system-level correctness.

## What stays on the expensive model

- Decomposition itself, ambiguity resolution, architecture/API decisions.
- Review of integrated diffs — taste, coherence, security.
- Anything whose acceptance check would be "looks right to me."
- The RSI loop's Propose / Predict / Select phases.

## What routes to cheap models

- Mechanical edits with cited patterns: renames, migrations, reformatting.
- Tests written from an existing spec or a failing repro.
- Doc/comment updates tied to code changes already made.
- Boilerplate, config plumbing, bulk mechanical changes.
- First-pass triage (reproduce, narrow, label) with the strong model
  confirming.

## Cost discipline

- Escalation budget per subtask: e.g. 2 cheap attempts, then strong model.
  Retrying a cheap model past its capability is more expensive than doing
  it strong the first time.
- Track a simple success rate per subtask *type*; drop types whose
  cheap-attempt success rate makes retries net-negative.
- The most expensive failure mode is a cheap model passing a weak check.
  Strengthen the check before trusting the route.

## Anchoring to this repo (opencode + goose)

- **opencode** — the fleet in `.config/opencode/agents/` encodes the roles
  structurally: `decompose` (planner), `executor` (cheap-tier role),
  `reviewer`, `retrospective`. No agent pins a model — routing is upstream —
  so tiers are role assignments, not hardcoded IDs. Subagents spawned via
  the `subagent` tool run in their own context (subtask noise stays out of the
  main thread), and `steps` caps bound runaway spend.
- **goose** — same split: planning stays on the session's routed model;
  mechanical fan-out goes to opencode subagents.
- The `AGENTS.template.md` decision checklist is the natural acceptance
  check for many subtask types (lint/test/typecheck already enumerated).

## Relation to the RSI loop

In `rsi-loop-playbook.md`, the base loop's **Implement** phase is the
natural routing point: once Propose/Predict produced a falsifiable spec,
the edit itself is often cheap-model-ready, while Evaluate/Select stay
strong-model + deterministic-verifier. The loop's retrospective should also
log which subtask types routed successfully — that log is itself a lesson,
and the meta loop can later tune the routing policy.
