<!-- Ledger fragment: opened 2026-09-30 as the P4 reviewer-bind record (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution: bind the reviewer delta to its RUN task (Landed — the reviewer runtime's correlated task is now `run:<reviewerRunId>`; issue #283 stays OPEN for the out-of-process interactive sink and the server-topology split) (2026-09-30)

**Source:** GitHub issue #283. Predecessor: the interactive-sink fragment
(`docs/ledger/P4-interactive-sink.md`), whose recorded residual was exactly
this: the reviewer lane's completed-turn delta was RECORDED (the forwarded
journal writer works) but attributed to the runtime's lazy-correlated session
task `hub-reviewer:<id>` rather than `run:<reviewerRunId>`, so the per-task
view — which joins `run:<id>` (`taskUsageForRun`, `src/ui/webapp/run-detail-panel.tsx:110-113`)
— did not render it under the reviewer run.

**Root cause.** `ReviewerAgentSessionFactory.spawn` never received the reviewer
run id; `HubReviewerRunner.reviewRun` generates `reviewerRunId =
schedule:hub-reviewer-<uuid>` and registers it with `controller.begin`, but
passed only `{ workspace, taskPrompt }` to the spawned session. The composition
root (`src/cli/hub.ts` `createReviewerFactory.createRuntime`) therefore had no
choice but to correlate the ACP runtime to the `hub-reviewer:<id>` session task
it opened with `beginKernelSessionTask`.

**What landed (branch `feat/p4-reviewer-bind`; commit below):**

- **`src/integrations/hub-reviewer.ts` — the run id rides the spawn seam.**
  `ReviewerAgentSessionFactory.spawn` gains `readonly reviewerRunId: string`;
  both call sites (the single-session path and `#reviewOneUnit`, whose
  signature gained the id as a parameter) forward it. The runner already knows
  the id when it spawns; nothing new is generated.
- **`src/integrations/hub-run-gates.ts` — the run task id helper + the
  forward.** New exported `reviewerRunTaskId(reviewerRunId): TaskId` returns
  the canonical run task id (`run:` prefixed with the reviewer run id) — the
  one expression the production composition and the view join share.
  `createRuntime`'s input type gains `reviewerRunId`, forwarded via the
  existing `{ ...input, recordTaskUsage }` spread.
- **`src/cli/hub.ts` — the reviewer runtime correlates to the run task.**
  `createRuntime` destructures `reviewerRunId` and passes
  `reviewerRunCorrelationTaskId = reviewerRunTaskId(reviewerRunId)` as
  `createConfiguredAcpRuntime`'s `taskId` argument (was
  `reviewerTask.taskId`). The ACP driver's W111 boundary pointer is its
  existing lazy correlation (`src/integrations/acp-session.ts`
  `readTaskId: () => this.#correlatedTaskId()`), read at boundary time — so a
  COMPLETED reviewer turn now publishes its delta with `taskId =
  run:<reviewerRunId>` and the view join renders it. The `hub-reviewer:<id>`
  session task stays the #134 lifecycle bookkeeping task only (still opened
  and closed by `endTask`); both tasks are IN_PROGRESS in the shared graph when
  the boundary is read.

**Pins (red-first):**

- `test/hub-run-gates.test.ts` (1 new pin): the factory forwards the reviewer
  RUN id into `createRuntime`, `reviewerRunTaskId(id)` is `run:<id>`, and a
  completed reviewer turn's delta (recorded under that exact id, mirroring the
  production correlation) lands in the registry's `taskUsage()` journal under
  `run:<reviewerRunId>`.
- `test/webapp-runs.test.ts` (1 new pin): the per-task view join
  (`taskUsageForRun`) renders a reviewer run's `run:<reviewerRunId>` entry under
  the reviewer run and does NOT claim the phantom `hub-reviewer:<id>` entry.

**Evidence (verbatim):**

- Red-first, `src/` stashed against the modified tests:
  `node --import tsx --test test/hub-run-gates.test.ts` →
  `# SyntaxError: The requested module '../src/integrations/hub-run-gates.js' does not provide an export named 'reviewerRunTaskId'`
  / `not ok 1 - test/hub-run-gates.test.ts` / `# tests 1 / # pass 0 / # fail 1`.
- Green after the implementation, per file:
  `hub-run-gates 8/8`, `hub-reviewer 37/37`, `webapp-runs 21/21`,
  `task-usage 7/7`, `acp-session 32/32`, `hub-runs 26/26` — **131/131 pass,
  0 fail, 0 skipped**.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**What remains unwired (stated, not hidden):**

- **The production binding itself (`hub.ts`'s `taskId` argument) is pinned at
  its composition seams, not by a live hub spawn.** The `reviewerRunTaskId`
  helper + the `reviewerRunId` forward are unit-pinned; the actual
  `createConfiguredAcpRuntime(..., reviewerRunCorrelationTaskId, ...)` call is
  CLI composition that requires spawning the hub and a real ACP agent to
  exercise live. The ACP driver's boundary behaviour (pointer read at boundary
  time, completed-only publication) was already pinned in
  `docs/ledger/P4-lane-wiring.md`.
- **The out-of-process interactive sink** (the four in-process surfaces:
  `src/cli/acp-tui.tsx`, `src/cli/ink-tui.tsx`, `src/cli/driver-registry.ts`,
  `src/ui/web-agents.ts` / `src/cli/web-service.ts`) stays unwired — no run
  registry, a process separate from the hub, §5 Q4 topology unbuilt.
- Brief §5 questions 2, 3, and 5 stay OPEN; the server-topology per-session
  split (brief §2.4) is still unbuilt; signature-dedup stays out with its
  persisted-event-ledger dependency named.
- **Issue #283 stays OPEN** — the reviewer lane's attribution now joins the
  run; the out-of-process interactive sink and §5 Q4 remain.
