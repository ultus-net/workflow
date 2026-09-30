<!-- Ledger fragment: opened 2026-09-30 as the P4 lane-wiring record (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution LANE WIRING (Landed — Q1 decided; the decided mechanism now composes at both host turn boundaries; issue #283 stays OPEN for the remaining questions) (2026-09-30)

**Source:** GitHub issue #283; the authoritative design input is
`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md` (§2 the design, §4 the sketch, §5 the
open questions). Predecessor: the W111 boundary mechanism
(`docs/ledger/W111-attribution-implementation.md`, commit `bed5ed80`) landed
`TaskUsageTracker`/`taskUsageDelta`/`resolveActiveTaskId`/`UNATTRIBUTED_TASK_ID`
(`src/integrations/task-usage.ts`), the run-registry `recordTaskUsage` journal,
and the `WorkflowHubSchedulerHandles.recordTaskUsage` seam — but wired no host
lane (issue #283 open).

**Q1 DECIDED (operator, 2026-09-30):** the active-task pointer is the run
application's task pointer — `run:<id>` is canonical, read via
`application.activeTaskId()` AT boundary time, never inferred; a throwing read
records the explicit unattributed absence. This resolves brief §5 question 1
(the task→run mapping policy) only. The other four questions stay OPEN.

**What landed (branch `feat/p4-lane-wiring`; commit below):**

- **`src/integrations/task-usage.ts`:** additive `TaskUsageAttributor` +
  `TaskUsageSink`. The shared lane-side boundary hook: `begin()` captures the
  cumulative baseline from the lane's metering reading, `end(completed)`
  publishes the delta through the sink's `record` — and ONLY on a completed
  turn (`failed`/`cancelled` pass no current reading, so the tracker clears the
  baseline and records nothing). The pointer is read inside `end` (boundary
  time), via the sink's `readTaskId`. The two lanes compose the SAME arithmetic
  rather than each re-implementing it.
- **`src/integrations/acp-session.ts`:** the ACP session lane's turn edge. A new
  optional `taskUsage` driver option; every `start()` turn baselines at turn
  start and, on the `end_turn` stop reason, reads the driver's existing lazy
  `taskId` correlation (the interactive `() => application.activeTaskId()`
  getter) at boundary time and publishes the delta. `cancelled`/unexpected stop
  reasons publish nothing; a thrown prompt (fail-closed) leaves no delta.
- **`src/integrations/acp-runtime.ts`:** additive `AcpRuntimeOptions.taskUsage`,
  passed through to all three driver flavors (opencode/cline/goose) so a
  composition root can supply the ACP lane's sink. The hub scheduler lane
  deliberately passes no sink here (it wires its own finally hook — no double
  count).
- **`src/cli/hub.ts`:** the hub scheduler lane's `runTurn` finally. `begin()`
  before `submit`, `end(state === "completed")` in the finally (before
  `dispose`), publishing through `handles.recordTaskUsage`. The pointer is
  `runApplication.activeTaskId()`, i.e. the canonical `run:<id>` task selected
  at `begin` — never inferred from the prompt, title, or workspace.

**Pins (red-first):**

- `test/task-usage.test.ts` (2 new pins): the lane hook publishes a completed
  turn's delta (P12 cache fields riding it) and nothing on failed/cancelled;
  the pointer is read ONLY at boundary time (not at `begin`) and a throwing
  read records `UNATTRIBUTED_TASK_ID` with the spend still recorded.
- `test/acp-session.test.ts` (4 new pins, the fake ACP agent): a completed turn
  publishes the exact delta through the injected sink; a failed
  (`invalid-update`) turn publishes none; a cancelled turn publishes none; an
  absent pointer on a completed turn records the unattributed absence.
- `test/hub-runs.test.ts` (1 new pin): the run application's active-task
  pointer is the canonical `run:<id>` (the exact read the scheduler lane's
  finally performs).

**Evidence (verbatim):**

- Red-first, `src/` stashed against the modified tests:
  `node --import tsx --test test/task-usage.test.ts test/acp-session.test.ts`
  → `# tests 28 / # pass 25 / # fail 3`, with
  `# SyntaxError: The requested module '../src/integrations/task-usage.js' does not provide an export named 'TaskUsageAttributor'`
  and, for the positive ACP pin,
  `not ok 23 - W111: a completed ACP turn publishes the per-task delta through the attribution sink` →
  `a completed turn publishes exactly one delta` / `0 !== 1`.
- Green after the implementation: `test/task-usage.test.ts` 6/6,
  `test/acp-session.test.ts` 27/27.
- Focused battery (task-usage + acp-session + hub-runs + hub-scheduler +
  hub-snapshot + usage-tracker): **81/81 pass, 0 fail, 0 skipped**.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Open questions left OPEN (brief §5, minus Q1):** (2) multiple concurrent
turns / one-proxy family granularity; (3) restart / baseline-epoch semantics;
(4) the server-topology per-session plumbing choice; (5) whether a persisted
event ledger is introduced (signature-dedup stays out with its dependency
named).

**Deviations / boundaries (stated, not hidden):**

- **No production sink is supplied to the interactive ACP lane yet.** The
  driver + runtime seams exist and are unit-pinned, but no composition root
  (acp-tui / web-agents / driver-registry) passes a `taskUsage` sink: those
  in-process surfaces hold no run registry to publish to. This is the same
  class of missing plumbing as the server-topology split (brief §2.4) and is
  left to the lane's owning composition. The hub scheduler lane (which owns
  `handles.recordTaskUsage`) IS wired.
- **The hub lane's `runTurn` finally composition is exercised through the
  shared `TaskUsageAttributor` pins + the `run:<id>` pointer pin**, not by a
  live hub-run integration test (that requires spawning the CLI and a real
  ACP agent; the focused suites stay offline).
- **No view rendering** (brief pin 4): the `/snapshot` `gateObservability.taskUsage`
  journal remains the recorded source; the per-task view is still queued.
- **The server-topology per-session split** (brief §2.4) is still unbuilt; the
  missing plumbing stays named.
- **Issue #283 stays OPEN** — the brief's acceptance criteria are now met for
  the decided parts (both-lane hook, boundary-time pointer, recorded absence,
  P12 fields through the delta, no-delta-on-failure); the view-derives-nothing
  criterion and the §5 questions remain.
