<!-- Ledger fragment: extracted from TASKS.md at line 1189 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W074 - Scheduled-task manager (backend landed; web page pending)

**Objective:** expose the existing hub cron engine as an operator-managed
scheduled-task surface: hub routes (`schedule/list|save|delete|run-now`), a
live schedule authority that persists via `saveSchedulesTable` and feeds the
running scheduler (today the table loads once and is frozen), a next-run
preview over `cronMatches`, and a Schedules page (nav slug beside Chat ·
Sessions · Usage) with create/edit, pause, run-now, delete, and last-outcome
correlation via `/snapshot` gateObservability.

**Status (2026-09-19, backend implemented + adversarially reviewed):**
`ScheduleDefinition` gained an `enabled` pause flag (retained but skipped by
`tick`); `nextCronMatch` and `HubScheduler.trigger(id)` added;
`schedule-registry.ts` owns the table live (list/get/save/remove; persists via
`saveSchedulesTable` before admitting; run-now attached to the scheduler); hub
routes `/schedule/list|save|delete|run-now` added (`hub-http.ts` +
`workflow-hub.ts`, which auto-wires the registry's run-now to the scheduler —
`run-now` is verifier-credential-gated after the adversarial review, P1-1);
overlapping tick/run-now fires are collapsed (in-flight guard + minute
consumption); `cli/hub.ts` now composes the live registry with an always-on
scheduler, so operator edits take effect without a hub restart. Focused suite
`test/schedule-manager.test.ts` (10 tests) green alongside the touched
hub-scheduler/hub-runs suites; lint and typecheck clean. **Pending:** the web
Schedules page and its SSR/CDP tests. **Residual:** schedule edits are
hub-single-writer (the existing instance lock guarantees one hub); a durable
registry across restarts is part of the long-horizon gap below.

## Long-horizon gaps recorded 2026-09-19 (OpenRouter cookbook)

The operator supplied OpenRouter's "Build a Long-Horizon Agent" cookbook; the
W073 loop and hub scheduler were checked against it. Gaps (honest, tracked):

- **Per-iteration step/token ceilings** on the candidate agent turn (W073
  budgets only at iteration boundaries via `usageUsd`).
- **Durable/resumable loop state**: the registry is in-memory; a hub restart
  loses running loops and iteration records. Adopt the cookbook's `StateAccessor`
  atomic temp+rename discipline (swallow only `ENOENT`).
- **Completion notification**: notify (webhook/event) when a loop terminates.

### Checkpoint F - bounded self-improvement loop landed

- [x] Wire a live proposal source (agent turn) and a production `measure` at a
      composition root.
- [x] Containment-wrap the git command runner (or route commits through the
      contained shell executor) and record the residual closure.
- [ ] Point the loop at a second repository to prove the workspace-parameterized
      control-plane capability end to end.
- [ ] Project the registry status/iteration records into the web UI (Sessions
      page card + `/rsi` surface-handled command) over the `/rsi/*` routes.
- [ ] Durable/resumable loop registry (atomic `StateAccessor`-style persistence)
      + per-iteration step/token ceilings + completion notification.

**Checkpoint F status (2026-09-21, boxes 1–2 implemented on
`feat/checkpoint-f-rsi-agent-wiring`):** `src/integrations/self-improvement-agent.ts`
composes the production loop (`createAgentDrivenRunLoop`): an agent-driven
proposal source over the full iteration history, an agent applier whose change
detection stays with `git status --porcelain` (an agent's claim can never
fabricate or suppress a change), a measure over a hub-executed command
(`WORKFLOW_RSI_MEASURE_COMMAND` must print one finite number; anything else
rejects the candidate fail-closed), and the git runner routed through the
hub's contained shell executor with constant command strings — commit messages
are staged inside the workspace `.git/` (0600, removed after the attempt, the
only path the sandbox mounts) and travel via `git commit -F`, with identity
carried on `git -c user.name/email` flags (the sandbox clears the
environment, so global gitconfig is unreachable — an independent review P0
caught the first version staging the message outside the mount, where the
commit could never complete; the fix is pinned end to end against the real
containment backend by
"the contained commit path completes on the real containment backend end to
end") and hook execution disabled (`--no-verify` +
`core.hooksPath=/dev/null`) so a planted pre-commit hook cannot run at commit
time. Recorded residual: a repo-configured clean filter
(`.gitattributes`/`.git/config`) still runs during `git add -A`, so committed
content can differ from the diff the reviewer saw — the enforcement for not
pointing the loop at untrusted repositories stays with the operator and the
guard (THREAT_MODEL 2026-09-21 §7). That closes the "git command runner runs
outside containment" residual from the W073 plan.
`cli/hub.ts` composes the registry lazily through the new
`createWorkflowHub` `selfImprovementFactory` handles seam (the same pattern as
`schedulerFactory`), with `WORKFLOW_RSI_AGENT` strict-parsed (`0` restores the
fail-closed refusal, `1`/unset enables, anything else refuses hub startup —
mirroring the `WORKFLOW_ACP_AGENT` precedent), and prompt templates
(`WORKFLOW_RSI_PROPOSAL_PROMPT` / `WORKFLOW_RSI_APPLY_PROMPT`) plus the
measure command are the operator/host config seams — the module defaults are
versioned source, and `{{placeholder}}` rendering fails closed on the
template only, so agent- or objective-authored `{{...}}` content passes
through as data. Honesty notes: the budget supplier counts SUCCESSFUL
proposal+apply turn cost only — a failed turn's spend is recorded in the
run-usage ledger (the turn runner records usage in `finally`) but not
budget-counted, and reviewer/test gate cost is metered by the hub's own run
usage (both recorded residuals); per-iteration step/token ceilings, the
durable registry, and completion notification remain the box-5 gaps; the web
UI projection (box 4) and the second-repository proof (box 3) are open.
Verification: `test/self-improvement-agent.test.ts` (18 tests: template
rendering/parse fail-closed + value-passthrough, mutator defers to git,
measure strictness, contained-git constant-command allowlist + `.git`-staged
`-F` message + hook hardening + refusal of unexpected verbs, the composed
loop's accept/verify/commit path, budget cap, boundary-scoped cancel,
proposal-failure and authority-refusal fail-closed stops, prompt prefix, and
the real-backend contained-commit pin), `test/hub-rsi.test.ts` (6 tests,
incl. the factory composition pinning that the registry is built against the
real run-registry controller), regression on
`test/self-improvement-loop.test.ts` (32/32); typecheck and lint clean.

## Phase 16: Settings Panel, Launcher Engine Axis, and Hub Orientation (2026-09-20)

The operator panel rollout (selector `13269a9`, connector catalog `c221908`, model routing
`91ab09f` is **complete**). Remaining slices of the agreed sequence plus the hub-briefing design
decision (recorded in project memory 2026-09-20).
