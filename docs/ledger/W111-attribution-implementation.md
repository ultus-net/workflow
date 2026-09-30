<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W111 - The per-task attribution IMPLEMENTATION (Partial - the decided mechanism landed; lane wiring and issue #283 stay OPEN) (2026-09-30)

**Source:** GitHub issue #283 (the W111 per-task attribution item); the
authoritative design input is `docs/W111_ATTRIBUTION_DESIGN_BRIEF.md`
(§2 the design, §4 the sketch, §5 the open questions). Operator-approved
2026-09-24: "turn-boundary deltas paired with the active-task pointer at
boundary time (the UsageTurnTracker pattern); the server-topology path needs
new plumbing for per-session split" (quoted in the design fragment,
`docs/ledger/W111-attribution-design-brief.md:5-10`).

**What landed (the DECIDED parts of the mechanism):**

- **`src/integrations/task-usage.ts` (new, pure):** the boundary arithmetic,
  extracted side-effect-free so it is unit-testable without a live proxy
  (`TaskUsageTracker`, mirroring `UsageTurnTracker.observe`,
  `src/ui/usage.ts:34-58`): `begin` captures the cumulative baseline at turn
  start, `complete`/`observe` compute the per-field delta
  `current − baseline` floored at zero (`Math.max(0, …)`, `src/ui/usage.ts:50-51`),
  and ONLY a `completed` edge publishes — `failed`/`cancelled` clear the
  baseline and publish nothing. The active-task pointer is read AT boundary
  time via a caller-supplied `() => string`; `resolveActiveTaskId` returns the
  read verbatim and turns a throwing read (`application.activeTaskId()`,
  `src/application/workflow.ts:412-417`) into the explicit
  `UNATTRIBUTED_TASK_ID` marker — an absent pointer is recorded, never
  inferred. The additive `TaskUsageSummary` mirrors `RunUsageSummary`
  (`src/integrations/run-registry.ts:43-58`) field for field and carries the
  P12 `cacheReadTokens`/`cacheCreateTokens`.
- **`src/integrations/run-registry.ts`:** additive `recordTaskUsage` /
  `taskUsage()` — a bounded append journal (FIFO at 64, the sibling gate-map
  bound) rather than the `runUsage` latest-wins map, because a task can span
  turns and the per-task rollup is the SUM of recorded entries; the journal
  rides `gateObservability` beside `runUsage`.
- **`src/integrations/run-controller.ts`:** additive optional
  `gateObservability().taskUsage` (`readonly TaskUsageSummary[]`).
- **`src/integrations/hub-http.ts`:** additive serialization on `/snapshot` —
  `gateObservability.taskUsage` and the `runs` block carry the journal (absent
  source → no field, the W115 discipline); record-only, no view derivation.
- **`src/integrations/workflow-hub.ts`:** the additive
  `WorkflowHubSchedulerHandles.recordTaskUsage` seam (wired to
  `runs.recordTaskUsage`) — the integration point a host lane will call; no
  lane is wired yet (see the open questions).

**What did NOT land (and why):**

- **No host-lane wiring.** The brief's acceptance criterion "the boundary hook
  composes in both the ACP and hub-scheduler lanes" is NOT met. The
  hub-scheduler lane's pointer read is entangled with open question 1 (the
  task→run mapping policy: the run application's `activeTaskId()` is
  `run:<id>` by construction, `src/integrations/run-registry.ts` `begin`,
  while the brief §2.2's parenthetical names an auto-activated interactive
  task); the ACP lane is entangled with open questions 2-4 (concurrency/family
  granularity, restart baseline epoch, the server-topology plumbing choice).
  Choosing a lane target here would silently decide an operator-level policy,
  so the wiring is left for that decision and only the mechanism + seam landed.
- **No view rendering.** The brief's pin 4 (the view sums recorded entries;
  a task with no entry renders absent, never zero) and the "hook composes in
  both lanes" criterion remain unimplemented; the existing
  `gateObservability.taskUsage` field is the recorded source such a view would
  sum.

**Open questions left open (all five, per the brief §5):** (1) task→run mapping
policy; (2) multiple concurrent turns / one-proxy family granularity; (3)
restart / baseline-epoch semantics; (4) the server-topology per-session
plumbing choice; (5) whether this iteration introduces the persisted event
ledger (signature-dedup stays out with its dependency named). None is decided
by this change; the mechanism is lane-neutral and the seam is inert until a
lane is chosen.

**Evidence:** red-first — with the implementation stashed,
`test/task-usage.test.ts` failed `ERR_MODULE_NOT_FOUND` (the module is the
feature) and the two `W111` tests in `test/hub-runs.test.ts` failed
`registry.recordTaskUsage is not a function` /
`handles.recordTaskUsage is not a function`. Green — `test/task-usage.test.ts`
4/4 pass and `test/hub-runs.test.ts` 24/24 pass. `test/hub-snapshot.test.ts`
4/4 pass (the additive `/snapshot` field). `npm run lint` exit 0 and
`npm run typecheck` exit 0 unpiped. `test/workflow-hub.test.ts` shows 1 failure
("workflow-hub CLI did not create its discovery file") that is pre-existing and
environmental — it fails identically with the implementation stashed (the
spawned CLI in this worktree), not a regression.

**Boundaries (remains):** the host-lane wiring, the per-task view, the
server-topology per-session split, and signature-dedup stay out of scope with
their dependencies named; **issue #283 stays OPEN** — the brief's acceptance
criteria (`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md:258-269`) are only partly
met (the pure mechanism, the pointer read + recorded absence, the P12 fields
through the delta, and no-delta-on-failure; the both-lane hook and the
view-derives-nothing criteria are not).
