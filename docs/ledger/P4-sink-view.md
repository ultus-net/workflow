<!-- Ledger fragment: opened 2026-09-30 as the P4 sink + per-task view record (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution SINK + VIEW (Landed — the driver-side sink now composes at a registry-holding root; the recorded journal is rendered per task; issue #283 stays OPEN for the remaining §5 questions) (2026-09-30)

**Source:** GitHub issue #283. Predecessors: the W111 mechanism
(`docs/ledger/W111-attribution-implementation.md`, commit `bed5ed80`) and the
lane wiring (`docs/ledger/P4-lane-wiring.md`, branch `feat/p4-lane-wiring`),
which left two named boundaries: **no production sink was supplied to the
interactive ACP lane**, and **the per-task view was still queued**. This
fragment closes both, as far as the current topology honestly allows.

**Composition-root finding (deliverable 1).** The driver-side seam is
`AcpRuntimeOptions.taskUsage` (`src/integrations/acp-runtime.ts:133-144`); the
`AcpSessionDriver.start()` turn consumes it (`src/integrations/acp-session.ts`).
The production roots that hold a run registry are the hub's run lanes; the
in-process interactive surfaces named by the prior fragment
(`src/cli/acp-tui.tsx`, `src/cli/ink-tui.tsx`, `src/cli/driver-registry.ts`,
`src/ui/web-agents.ts`) hold NO run registry, and there is no cross-process
record path (the server-topology per-session split is brief §5 Q4, operator-open
— deliberately not invented here). So **no root holds both the interactive
runtime and the registry**; the smallest correct seam is at the registry-holding
root that composes an ACP runtime with no driver-side sink yet.

**What landed (branch `feat/p4-sink-view`; commit below):**

- **`src/cli/hub.ts` — the RSI lane's ACP runtime** (`rsiAgentTurn`) now
  supplies the driver-side sink:
  `taskUsage: laneTaskUsageSink(() => runtime.metrics?.(), (delta) => handles.recordTaskUsage(delta))`.
  The RSI lane holds the run-registry handles and previously recorded no
  per-task attribution; a COMPLETED RSI turn (proposal or run) now publishes its
  boundary delta into the same journal the scheduler lane writes. The schedule
  lane is untouched — it deliberately passes no driver sink (it wires its own
  `runTurn` finally; passing both would double count).
- **`src/integrations/task-usage.ts` — `laneTaskUsageSink(usage, record)`.**
  The deferred composition the roots supply: the `usage` reading is taken
  LAZILY at the turn boundary (the runtime does not exist when the root builds
  the sink), the `record` writer is the lane's journal. Pure composition.
- **`src/ui/webapp/runs-record.ts`** — the `/api/runs` mirror gains
  `TaskUsageSummaryView` and the `runs.taskUsage` journal field (the relay
  already carried it from `/snapshot` gate observability).
- **`src/ui/webapp/run-detail-panel.tsx`** — the **per-task view**: the run
  detail's Cost tab renders the recorded entries for the run's canonical
  `run:<id>` task (`taskUsageForRun`) verbatim, plus the recorded rollup
  (`sumTaskUsage`, the SUM of recorded entries — never a delta recomputed from
  cumulative counters), with the blank-line boundary statement. A hub that omits
  the family renders "task attribution not recorded by this hub"; a run whose
  task recorded nothing renders "no task attribution recorded for this run".
  Projection-only: the view derives no task id and no delta.

**Pins (red-first):**

- `test/task-usage.test.ts` (1 new pin): a lane-supplied driver sink publishes a
  COMPLETED turn (deferred reading, exact delta, P12 cache fields) and nothing
  on a failed turn — the composition shape, not only the arithmetic.
- `test/webapp-runs.test.ts` (1 new pin, + `fullRunsRecord` fixture grows the
  `taskUsage` journal): the per-task view renders each RECORDED delta verbatim
  (cost, `recordedAt`, cache r/w), the rollup a SUM of records, names the
  absent/empty states, claims no other run's task entry (exact `run:<id>` join),
  and never imports `taskUsageDelta` (no view-side derivation).

**Evidence (verbatim):**

- Red-first, `src/` stashed against the modified tests:
  `node --import tsx --test test/task-usage.test.ts test/webapp-runs.test.ts`
  →
  `# SyntaxError: The requested module '../src/integrations/task-usage.js' does not provide an export named 'laneTaskUsageSink'`
  / `not ok 1 - test/task-usage.test.ts`;
  `# SyntaxError: The requested module '../src/ui/webapp/run-detail-panel.js' does not provide an export named 'sumTaskUsage'`
  / `not ok 2 - test/webapp-runs.test.ts`; `# tests 2 / # pass 0 / # fail 2`.
- Green after the implementation: `test/task-usage.test.ts` 7/7,
  `test/webapp-runs.test.ts` 20/20.
- Focused battery (task-usage + acp-session + hub-runs + hub-scheduler +
  hub-snapshot + usage-tracker + webapp-runs): **102/102 pass, 0 fail,
  0 skipped** (7 + 27 + 25 + 14 + 4 + 5 + 20 per file, run individually).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**What remains unwired (stated, not hidden):**

- **The out-of-process interactive surfaces still pass no `taskUsage` sink.**
  `src/cli/acp-tui.tsx`, `src/cli/ink-tui.tsx`, `src/cli/driver-registry.ts`,
  and `src/ui/web-agents.ts` / `src/cli/web-service.ts` compose an ACP runtime
  over an in-process `WorkflowApplication` with no run registry; there is no
  record path from those processes to the hub's journal. Wiring them needs the
  brief §5 Q4 server-topology per-session plumbing decision (operator-open) —
  not invented here. So an interactive TUI/web session turn still does not
  publish a `TaskUsageSummary`.
- **The reviewer ACP lane** (`src/cli/hub.ts` `reviewerFactory`) still records
  no taskUsage: `RunReviewerFactory` receives only the run controller, not the
  registry's `recordTaskUsage`; wiring it is a seam/signature change left to its
  own iteration.
- **The scheduler lane's hand-wired finally is unchanged** (by design).
- **The server-topology per-session split** (brief §2.4) is still unbuilt; the
  missing plumbing stays named.
- Brief §5 questions 2-5 stay OPEN; signature-dedup stays out with its
  persisted-event-ledger dependency named.
- **Issue #283 stays OPEN** — the view-derives-nothing criterion is now met for
  the run surface and the driver-side sink composes at the registry-holding
  root; the out-of-process interactive sink and §5 Q4 remain.

**2026-09-30 (dated supersession — the shared in-process composition seam):**
the unified ask-answer surface (`docs/ledger/ask-answer-surface.md`, issues
#285/#283) lands a second consumer of the SAME in-process composition root named
above — `AcpRuntimeOptions` now threads the shared `PermissionBroker` into all
three ACP driver flavors, and the driver derives a broker-backed ask hold from
it. This does **not** touch the W111 attribution sink or the per-task view: the
interactive roots still publish no `TaskUsageSummary`, and §5 Q4
(server-topology per-session plumbing) stays OPEN. It is recorded here only
because it exercises the identical root, evidencing that a broker-backed
per-session seam is now available there if the attribution lane's owning
composition chooses the same route.

> **Dated note (2026-09-30, branch `feat/harvest-4`): the shared 64-slot
> journal's cross-lane eviction pressure, named.** The per-task attribution
> journal is ONE append journal (`recordTaskUsage`/`taskUsage()`,
> `src/integrations/run-registry.ts:273-283`), FIFO-evicted at 64 entries and
> SHARED across every lane that supplies a driver sink (the RSI lane wired here,
> the scheduler lane, and any future lane). Because the W111 record's rule is
> that entries are NEVER collapsed latest-per-task (the per-task rollup is the
> SUM of recorded entries, so a lost entry under-reports), a burst of turns on
> one lane can evict another lane's still-un-summed entries before a reader
> renders them — the eviction is cross-lane, not merely intra-lane. This is
> recorded as a named boundary, not fixed here: a fix needs either per-lane/
> per-run partitioning of the journal or a larger bound, and both change the
> `/snapshot`→`/api/runs` projection contract. The review's P3 (commit
> `4d1b5970`) is thereby dispositioned as a named residual.
