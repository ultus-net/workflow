<!-- Ledger fragment: opened 2026-09-30 as the P4 interactive-sink record (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution: the interactive lanes' sink (Landed — the reviewer ACP lane is wired at the registry-holding root; the four interactive surfaces hold no registry and stay named; issue #283 stays OPEN for the server-topology split) (2026-09-30)

**Source:** GitHub issue #283. Predecessor: the P4 sink+view fragment
(`docs/ledger/P4-sink-view.md`), which wired the RSI ACP lane and left two
named boundaries: the out-of-process interactive surfaces (no registry, no
cross-process path) and the reviewer ACP lane (`RunReviewerFactory` receives
only the run controller, not the registry's `recordTaskUsage`).

**Composition-root finding (deliverable 1).** The four interactive surfaces
named by the prior fragments — `src/cli/acp-tui.tsx`, `src/cli/ink-tui.tsx`,
`src/cli/driver-registry.ts`, `src/ui/web-agents.ts` (composed by
`src/cli/web-service.ts`) — each build their own in-process
`WorkflowApplication` and hold NO run registry. There is no record path from
those processes to the hub's journal: the web service is a separate process
from the hub (`src/cli/workflow.ts` spawns the hub as its own daemon), and the
server-topology per-session split (brief §2.4, §5 Q4) is still unbuilt. Wiring
them would be cross-process plumbing the brief deliberately did not invent, so
they stay unwired and named. The remaining registry-holding composition root
that composes an ACP runtime with no driver-side sink is the **reviewer lane**
(`src/cli/hub.ts` `reviewerFactory.createRuntime`), which holds the hub's run
registry through the registry's own call site.

**What landed (branch `feat/p4-interactive-sink`; commit below):**

- **`src/integrations/run-registry.ts` — `RunReviewerFactory` gains the
  per-task journal writer.** The factory signature is now
  `(controller, recordTaskUsage) => RunReviewer`; the registry's review-launch
  site passes its own `rememberTaskUsage` closure
  (`options.reviewer(controller, rememberTaskUsage)`). The second argument is
  additive: a factory that ignores it stays valid. (The journal writer is the
  closure, not `controller.recordTaskUsage` — the controller interface does
  not carry the journal; the registry object does.)
- **`src/integrations/hub-run-gates.ts` — `createReviewerFactory` forwards the
  writer into `createRuntime`.** The factory returns
  `(controller, recordTaskUsage) => …` and passes `recordTaskUsage` into
  `options.createRuntime({ ...input, recordTaskUsage })`, so the composition
  root's runtime closure can supply the driver sink. Stubs that ignore the new
  field stay valid.
- **`src/cli/hub.ts` — the reviewer lane's ACP runtime supplies the sink.**
  `createRuntime` now destructures `recordTaskUsage` and passes
  `taskUsage: laneTaskUsageSink(() => runtime.metrics?.(), (delta) => recordTaskUsage(delta))`
  to `createConfiguredAcpRuntime`. Each COMPLETED reviewer turn publishes its
  boundary delta into the one journal the scheduler and RSI lanes write;
  `failed`/`cancelled` publish nothing (the ACP session's honesty rule). The
  `runtime` const carries an explicit `WorkflowAcpRuntime` annotation: the
  `.catch` cleanup chain made the deferred self-reference
  (`() => runtime.metrics?.()`) circular to inference (TS7022/TS7024), which
  the annotation breaks.

**Attribution target (named, not hidden).** The sink's pointer is the ACP
driver's existing lazy correlation (`src/integrations/acp-session.ts`
`#correlatedTaskId`), which for the reviewer runtime is the reviewer session
task `hub-reviewer:<uuid>` opened by `beginKernelSessionTask` — IN_PROGRESS
for the review's whole lifetime, read at boundary time, never inferred. The
per-task view (`taskUsageForRun`) joins on `run:<id>`, so a reviewer delta is
RECORDED but does not render under the reviewer run's `run:` task; binding the
reviewer runtime to `run:<reviewerRunId>` is a larger task-binding change left
to its own iteration.

**Pins (red-first):**

- `test/hub-run-gates.test.ts` (1 new pin): the reviewer factory forwards the
  registry's per-task journal writer into the reviewer runtime — a completed
  review (stub runtime publishing one delta through the forwarded writer)
  records exactly one entry in the registry's `taskUsage()` journal.

**Evidence (verbatim):**

- Red-first, `src/` stashed against the modified test:
  `node --import tsx --test test/hub-run-gates.test.ts` →
  `not ok 7 - W111 (issue #283): the reviewer factory forwards the registry's per-task journal writer into the reviewer runtime`
  / `error: 'cannot verify run author-8: hub reviewer failed: recordTaskUsage is not a function'`
  / `# tests 7 / # pass 6 / # fail 1`.
- Green after the implementation: `test/hub-run-gates.test.ts` 7/7.
- Focused battery (hub-run-gates + hub-reviewer + hub-review + task-usage +
  hub-runs + acp-session + hub-scheduler + webapp-runs): **146/146 pass,
  0 fail, 0 skipped** (7 + 37 + 5 + 7 + 25 + 31 + 14 + 20 per file, run
  individually).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**What remains unwired (stated, not hidden):**

- **The four in-process interactive surfaces still pass no `taskUsage` sink.**
  `src/cli/acp-tui.tsx`, `src/cli/ink-tui.tsx`, `src/cli/driver-registry.ts`,
  and `src/ui/web-agents.ts` / `src/cli/web-service.ts` compose an ACP runtime
  over an in-process `WorkflowApplication` with no run registry, in a process
  separate from the hub; there is no record path to the hub's journal. Wiring
  them needs the brief §5 Q4 server-topology per-session plumbing decision
  (operator-open) — not invented here. So an interactive TUI/web session turn
  still does not publish a `TaskUsageSummary`.
- **The reviewer delta's task id is the reviewer session task
  (`hub-reviewer:<id>`), not the reviewer run's `run:` task** — recorded, but
  not joined by the current per-task view (the residual above).
- **The server-topology per-session split** (brief §2.4) is still unbuilt; the
  missing plumbing stays named.
- Brief §5 questions 2, 3, and 5 stay OPEN; signature-dedup stays out with its
  persisted-event-ledger dependency named.
- **Issue #283 stays OPEN** — the reviewer ACP lane's driver-side sink now
  composes at the registry-holding root; the out-of-process interactive sink
  and §5 Q4 remain.
