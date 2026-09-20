# W073 — Bounded recursive self-improvement loop (the Karpathy loop, under Workflow authority)

**Plan date:** 2026-09-19. **Status:** IMPLEMENTED on branch
`feat/w073-self-improvement-loop` (operator direction: "implement the loop
end-to-end; the agent improves the Workflow repo itself"). This plan is the
specification the implementation is bound to; `TASKS.md` W073 records the
landed evidence.

**Provenance:** operator request citing two sources — MindStudio's *"What Is
Recursive Self-Improvement in AI? The Karpathy Loop Explained"* and
Anthropic's *"When AI builds itself"* (The Anthropic Institute,
`anthropic.com/institute/recursive-self-improvement`). Both describe the same
loop shape: an agent **proposes** a change, **implements** it, **executes**
tests, **evaluates** the result, and **commits or discards** — repeating from
the newest best state. Both stress the same safety framing: the loop is
bounded by a human-defined objective, changes are auditable, and rollback is
explicit. This item implements that loop *on top of* Workflow's existing
authority, evidence, and review machinery rather than beside it.

## The core claim (and the honest boundary)

The loop does **not** modify model weights and does **not** grant the agent
authority. It is a deterministic orchestrator in the integration layer that:

- takes an **operator-defined objective** (workspace, description, optional
  scalar measure and direction) as the only source of "better";
- routes every candidate through `WorkflowRunController.begin` / `finish`
  (the canonical run lifecycle), so a candidate can only count as accepted
  when the kernel reaches `VERIFIED` on fresh evidence — hub-run tests and,
  when configured, an independent reviewer;
- commits a candidate **only after** the kernel verified it, and discards
  otherwise;
- stops on explicit bounds (`maxIterations`, consecutive-rejection streak,
  optional cost budget, proposal exhaustion).

This is recursive *self-improvement through tooling* — the article's own
definition (`self-improvement through tooling`, not `self-modification`) — and
it is deliberately the **bounded, auditable** variant both sources describe.

## Architecture placement

| Concern | Where | Rule |
|---|---|---|
| Loop orchestration, proposals, git commit/discard | `src/integrations/self-improvement-loop.ts` | integration layer: composition only; may do IO |
| Candidate authorization + evidence | existing `src/application/workflow.ts` + `src/integrations/run-registry.ts` | unchanged; the loop holds only the `begin`/`finish` subset |
| Kernel | untouched | kernel purity rule holds: no loop concept enters the kernel |

The loop depends on **seams** (proposal source, candidate workspace,
authority, measure), so the orchestrator is deterministic in tests and the
real adapters (agent applier, git workspace) are injected at composition time.
No new authority is invented: the accepted-candidate gate is the existing run
verification path.

## Loop algorithm (per iteration)

1. `proposals.next(context)` → a proposal. `undefined` stops the loop
   (source exhausted). A malformed proposal fails closed (stop, no mutation).
2. `authority.begin({ runId, workspace, requiresReview, taskPrompt })` —
   creates the canonical run task. If authority refuses, the loop stops
   without mutating (fail closed).
3. `workspace.apply(...)` — the agent makes the change. If it throws or
   reports no change, the run is closed `failed` and the workspace discarded.
4. If the objective declares a `measure`, it is evaluated after apply. When an
   incumbent score exists and the new score does not improve on it
   (`direction` decides), the candidate is rejected: close `failed`, discard.
5. `authority.finish({ outcome: "verified" })` — the authoritative gate: the
   kernel runs hub tests (and reviewer evidence when required) and only then
   reaches `VERIFIED`. A throw rejects the candidate: close `failed`, discard.
6. On `VERIFIED`: `workspace.commit(...)` records the change with a commit
   ref. A verified-but-uncommittable candidate stops the loop (fail closed) —
   the loop never claims a commit it did not make.
7. With no `measure` declared, the first verified candidate is the goal and
   the loop stops. With a `measure`, iteration continues from the newest
   verified state until a bound is hit.

Every iteration appends a `LoopIterationRecord` (proposal, hypothesis,
changed, runId, verdict, reason, optional score, optional commitRef,
observedAt). The record is the audit trail; nothing is silently dropped.

## Safety invariants (each pinned by test)

- **I-A** A candidate is committed only after `finish("verified")` resolves;
  tests proving a rejected candidate never commits and is discarded.
- **I-B** An authorization/`begin` failure mutates nothing and stops the loop.
- **I-C** An apply failure, an unchanged candidate, a non-improving score, or a
  thrown verification all discard the candidate and close the run `failed`.
- **I-D** The loop is single-instance per workspace: a second concurrent
  `run()` for the same workspace is refused.
- **I-E** Bounds stop the loop deterministically: `maxIterations`,
  `maxConsecutiveRejections`, and the optional cost budget.
- **I-F** The objective is validated up front (absolute workspace, non-empty
  description, positive integer iteration cap, valid direction); an invalid
  objective throws before any proposal is requested.
- **I-G** A verified candidate that cannot be committed stops the loop; the
  outcome reports it as uncommitted, never as committed.

## Slices

1. **S1 — plan + module skeleton** (`self-improvement-loop.ts`): objective,
   proposal, workspace, authority, limits, audit-record types; validation.
2. **S2 — loop** with the algorithm above and the audit/bounds rules.
3. **S3 — git candidate workspace** over an injected command runner
   (`createGitCandidateWorkspace`): change detection, commit, destructive
   discard of uncommitted work in a dedicated workspace.
4. **S4 — composition helper** (`createAuthorityGate`): plain delegation to a
   `WorkflowRunController`, documented as the production wiring point.
5. **S5 — tests**: fake seams for hermetic unit coverage; one integration test
   composing the real `createRunRegistry` (fake reviewer + test runner) to
   prove evidence-bound acceptance end-to-end; one git test on a temp repo.

## Acceptance criteria

- [ ] `src/integrations/self-improvement-loop.ts` implements the algorithm and
      exports the objective/proposal/workspace/authority/limits/outcome types.
- [ ] Focused tests cover I-A…I-G and the full propose→verify→commit path.
- [ ] An integration test proves the accepted candidate's run reaches
      `VERIFIED` with recorded `environment` evidence through the real
      `createRunRegistry`, and a rejected candidate's run ends `FAILED`.
- [ ] The git workspace detects changes, commits, and discards on a temp repo.
- [ ] `npm run lint`, `npm run typecheck`, and the focused test file pass.
- [ ] Independent five-axis review recorded before merge.

## Verification

`node --import tsx --test test/self-improvement-loop.test.ts`; `npm run lint`;
`npm run typecheck`; the recorded review.

## Explicit non-goals / residuals

- **No weight modification, no kernel change, no enforcement claim.** The loop
  composes existing authority; it adds none.
- **The agent applier is a seam.** The production applier (an ACP turn) and the
  production measure are composition-time choices; this item ships the
  orchestrator and the git workspace, not a new agent runtime.
- **`measure` runs on the candidate tree before the authoritative gate** and
  must tolerate a broken intermediate state (it is a heuristic, not a gate).
- **Git commit runs outside Bubblewrap** in this first slice — it is the loop's
  own hub-side action on a dedicated workspace, not an agent tool call.
  Containment-wrapping the command runner is a follow-up residual, recorded
  here rather than silently assumed.
- **Proposals are not yet sourced from a live model** in tests; the seam is the
  integration point. Live agent wiring is follow-up work.
- **`git add -A` is workspace-wholesale.** Change detection (`git status
  --porcelain`) and the commit attribute *any* uncommitted dirt in the
  workspace to the candidate. The workspace must therefore be dedicated to the
  loop (a clean checkout at a pinned baseline); pre-existing dirt is the
  operator's responsibility. Recorded residual, not a silent assumption.
- **Budget is checked at iteration boundaries.** One iteration can overshoot
  `budgetUsd` by the cost of its own work; `usageUsd` granularity is the
  operator's choice.

## Prior-art / current-state check (2026-09-19)

The space is fast-moving, so the design was checked against current (September
2026) guidance rather than only the two operator-provided sources. Mapping:

- **Anthropic, "Building effective agents"** (engineering post; now points to
  Claude Managed Agents): agents are "LLMs using tools based on environmental
  feedback in a loop"; "it's common to include stopping conditions (such as a
  maximum number of iterations)"; and "we recommend extensive testing in
  sandboxed environments, along with the appropriate guardrails." → W073 takes
  environmental ground truth as the acceptance gate (`authority.finish`
  running the hub test command + reviewer), enforces `maxIterations`, and
  records sandboxing as an explicit residual (the git runner is not yet
  Bubblewrap-wrapped). Anthropic's **evaluator-optimizer** pattern is the
  shape of `measure` (heuristic, pre-gate) + the independent reviewer
  (authoritative, post-gate); human review "remains crucial" is encoded as the
  reviewer-evidence requirement.
- **Claude Code autonomous scheduling (`/goal`, `/loop`, `/routines`)** current
  best practice: goals must be "specific and measurable"; "set a max iteration
  count"; "scope the working directory"; and "use concrete exit conditions —
  binary checks (tests pass/fail, linter returns 0) are more reliable than
  subjective ones." → W073 requires an objective at construction, scopes every
  mutation to `objective.workspace` through `WorkflowApplication`, makes the
  binary test command the gate, and uses `measure` only as the improvement
  comparator. The documented `/goal` failure mode (runaway loop on an unclear
  or impossible goal) is bounded by `maxIterations` + the
  consecutive-rejection streak.
- **METR time-horizon evals** (Time Horizon 1.1, Jan 2026; the Anthropic
  Institute piece cites ~4-month doubling, up from ~7 months): reliably
  completable task horizons keep extending, which is exactly why the loop
  keeps the *authority* and *evidence* outside the agent and demands an audit
  record per iteration. METR's **monitorability evaluations** (Jan 2026) are
  the external analogue of W073's `LoopIterationRecord` journal; routing that
  journal into W053's supervisor layer is noted follow-up, not invented here.

**Design deltas from the check:** none required for correctness. Two
reinforcements adopted: (1) the no-comparator default stops after the first
verified candidate (a concrete goal, not an open-ended `/loop`); (2) the
`/goal` lesson that an underspecified objective is the primary runaway risk is
recorded as the reason objective validation is fail-closed at composition
time. The containment residual is upgraded in priority by the sandboxing
guidance and is tracked in Checkpoint F.

## Trigger / monitor / cancel surface (2026-09-19, operator-directed)

The operator asked for a way to start, monitor, and cancel the loop, and chose
the hub-owned registry + admin CLI + hub API path over a UI-first slice, with
**cancel scoped to the iteration boundary** (never mid-mutation). Landing:

- **Loop cancel hook** (`self-improvement-loop.ts` `shouldStop`): a cooperative
  predicate checked at each iteration boundary; a throwing predicate fails
  closed. The in-flight candidate always completes its gate.
- **Hub-owned registry** (`self-improvement-registry.ts`): `start` / `status` /
  `cancel`, validated specs, duplicate refusal per realpath workspace (aliases
  included), bounded history, and cancellation recorded as state `cancelled`.
  It drives the loop through an injected `LoopRunner` seam; it never holds
  repository authority itself.
- **Hub API** (`hub-http.ts` + `workflow-hub.ts`): `POST /rsi/start|status|cancel`
  and `/schedule/list|save|delete|run-now`. **`/rsi/start` and
  `/schedule/run-now` require the verifier credential** (the credential that
  may finish runs, distributed separately from the ordinary surface token);
  `status`/`cancel` and schedule CRUD use the operator token. When no registry
  is configured the routes 404.
- **Operator CLI** (`src/cli/rsi.ts`, bin `workflow-rsi`): a thin client over
  those routes that holds no authority and never runs a loop in-process;
  `start` reads `verifier.json`.

**Boundary, stated precisely (revised after the adversarial review):** the
*ordinary surface token* cannot start a loop or fire a schedule — that is a
route-level credential gate, the same trust model as `/run/finish`. It is NOT a
process-level boundary: a same-UID agent process that can read `verifier.json`
and reach the loopback hub can start a loop, and the ordinary token's blast
radius already includes `/bash`. `THREAT_MODEL.md` (2026-09-19 §1) records this
as the binding residual. What forbids model-initiated self-modification in
practice is this gate plus Workflow's existing containment/authorization model
— not a magic isolation of this endpoint. The production `LoopRunner` (live
proposal source + agent applier + measure) is still a composition-time seam and
remains Checkpoint F work.

### Adversarial review round (2026-09-19, operator-directed)

An adversarial reviewer with independent web research
(`[REQUEST_CHANGES]`, recorded: 2×P0, 2×P1, 6×P2, 4×P3) found real blockers;
all four blocking findings were fixed and pinned:

- **P0-1 destructive git ops on a dirty tree** → `CandidateWorkspace.assertBaseline`
  is now a required seam called before the first candidate; the git
  implementation refuses a non-repository and a dirty tree (untracked
  included), so `reset --hard`/`clean -fd` can only ever revert the loop's own
  candidate changes. Tests: dirty-tree refusal, non-repo refusal, loop stops
  with zero authority engagement.
- **P0-2 vacuous default acceptance gate** → `/rsi/start` now defaults
  `requiresReview` to **true** (opt-out is an explicit `requiresReview: false` /
  `--no-review`); the default path is pinned by test. Honest note: with the
  review gate on but no hub `testRunner` wired, acceptance rests on reviewer
  evidence alone — the operator must wire the test command for the "hub tests"
  part of the claim.
- **P1-1 nominal agent boundary** → `/rsi/start` + `/schedule/run-now` now
  require the verifier credential; the CLI reads `verifier.json`; claims were
  rewritten (plan, module docs, TASKS.md) to the credential-scoped statement,
  and the full residuals are in `THREAT_MODEL.md` 2026-09-19 §1–6.
- **P1-2 candidate-authored reviewer ask** → the run's `taskPrompt` is now the
  operator's objective, never the proposal hypothesis; the hypothesis stays in
  the audit record only.

Also fixed: run-now/tick double-fire and overlapping fires (in-flight guard +
minute consumption), `cli/hub.ts` now composes the self-improvement registry
(fail-closed runner until Checkpoint F), cancelled-vs-stopped labelling, the
`trigger` doc contradiction, and the `nextCronMatch` horizon note.
Accepted-as-recorded P2/P3: THREAT_MODEL updated (above); SECURITY_ASSURANCE
checker sync is follow-up; `/schedule/delete` persist failures surface as 500
(fail-closed admission holds); `/schedule/save` persists unknown fields
(operator-token hygiene); reviewer-injection residual as above.

**Re-verification round (same adversarial reviewer):** one blocking finding —
the P1-2 fix (operator objective as the run ask) was correct in code but not
pinned, so reverting it would have passed the suite (an honest-claims
violation in this doc's "fixed and pinned" wording). Fixed: the loop test now
asserts `begins[0].taskPrompt` equals the operator objective and differs from
the candidate hypothesis. Also tightened: the registry labels `cancelled` only
on the loop's exact cancel outcome ("cancelled by operator") — a
"cancellation-check-failed" stop can no longer masquerade as an operator
cancel — and `readVerifierDiscovery` is exported and tested (absent/malformed
fail closed). Remaining accepted-as-recorded: unpinned fail-closed runner
composition in `cli/hub.ts` (P2-adjacent).

### W074 — Scheduled-task manager (backend landed 2026-09-19; UI pending)

The cron engine already exists (`hub-scheduler.ts`: 5-field parser, persisted
versioned table, budget/off-peak/review-gated runs; `hub.ts` drives a stock-ACP
OpenCode turn per fire). **Landed backend:** `enabled` pause flag on
`ScheduleDefinition` (a paused schedule is retained but skipped by `tick`),
`nextCronMatch` next-run preview, `HubScheduler.trigger(id)` run-now,
`self-improvement-registry`-style live `schedule-registry.ts` (list/get/save/
remove over the persisted table; persists via `saveSchedulesTable` before
admitting; run-now attached to the scheduler), operator-token hub routes
`/schedule/list|save|delete|run-now` (`hub-http.ts` + `workflow-hub.ts`, which
auto-wires the registry's run-now to the scheduler), and `cli/hub.ts` now
composes the live registry + an always-on scheduler (edits take effect without
a hub restart). **Still pending:** the web Schedules page (nav slug beside Chat
· Sessions · Usage) with create/edit, pause, run-now, delete, and last-outcome
correlation through `/snapshot` gateObservability; a scheduled RSI trigger
becomes a schedule kind rather than a new engine.

## Long-horizon guidance check (2026-09-19, OpenRouter cookbook)

The operator supplied OpenRouter's "Build a Long-Horizon Agent" cookbook. Its
four primitives map onto W073 as follows:

- **Hard ceilings** (`maxCost`, `stepCountIs`, `maxTokensUsed`, composed):
  W073 already bounds with `maxIterations` + `maxConsecutiveRejections` +
  optional `budgetUsd`. **Gap:** the budget is checked only at iteration
  boundaries and only when a `usageUsd` supplier is wired; there is no
  per-iteration step/token ceiling on the candidate's agent turn. Tracked.
- **Resumable state** (`StateAccessor`, atomic temp-file + rename, resume with
  `input: []`): **the real gap.** The loop registry is in-memory; a hub restart
  loses running loops and their iteration records. The cookbook's atomic-write
  discipline (only swallow `ENOENT`; temp+rename) is the model for a durable
  registry. Tracked in Checkpoint F.
- **Streaming progress**: `onIteration` + the registry `status()` feed the
  monitor by polling; SSE/streaming is a later surface upgrade.
- **Self-ask loop with adversarial review + `[DONE]` sentinel**: W073 uses the
  independent reviewer gate plus the consecutive-rejection bound — the same
  shape (research → adversarial review → repeat; stop on a cheap sentinel).
- **Completion notification**: no webhook/notify on loop completion yet;
  tracked as a small follow-up once the durable registry exists.

No correctness deltas required; three honest gaps recorded (per-iteration
ceilings, durable/resumable loop state, completion notification).

## Review record

**2026-09-19, independent five-axis review (fresh context, read-only):**
`[REQUEST_CHANGES]` with two P2s and five P3s. Both P2s fixed and pinned by
test:

- P2 "reject path can silently leave the workspace mutated" → the loop now
  surfaces rollback failures (`closeFailed`/`discard` return reasons), records
  them on the iteration record (`rollback incomplete: …`), and **stops the
  loop** instead of continuing over an unsafe tree (I-C tightened). Tests:
  "a failed rollback (discard throws)…", "a failed run close…".
- P2 "rejected run can be left unclosed" → same mechanism; the run-close
  failure is surfaced on the record and stops the loop.

P3 dispositions: commit-ref race fixed (a successful `git commit` with a
failing `rev-parse` now reports committed-without-ref instead of a false
"could not be committed"); the single-instance lock is keyed on `realpath` so
path aliases cannot bypass it; `usageUsd()` and `onIteration` throwing are now
guarded (a usage-supplier failure stops the loop fail-closed; the observer is
logged, never propagated); `git add -A` dirt and budget granularity are
recorded residuals above.

**2026-09-19, re-review after the fix round (fresh context, read-only):**
`[REQUEST_CHANGES]` on one P2 regression introduced by the fix round — the
acquire path normalized the lock key with `realpath` but `finally` released
the raw path, leaking the lock whenever realpath ≠ declared path (symlink /
trailing-slash aliases), which would permanently refuse later loops for that
directory. **Fixed:** `finally` now releases `lockKey`; a new test pins the
acquire/release symmetry across a symlink alias and the canonical path, and
the remaining new branches (rev-parse failure, throwing `usageUsd`, throwing
`onIteration`, and the both-rollbacks-failed reason) are pinned too. Combined
rollback-failure reporting now names both failures instead of the first only.
Suite is 27 tests, green; lint and typecheck clean.
