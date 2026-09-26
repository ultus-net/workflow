<!-- Ledger fragment: extracted from TASKS.md at line 1016 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W072 - Three-level decomposition ledger + strict-compliance register

**Objective:** Make the agent's decomposition a **deterministic, operator-gated ledger** —
roadmap/plan → canonical tasks → canonical steps/todos — so a task cannot be marked done while its
steps are open, and so goals/work cannot drift from the plan without operator approval. This is the
capability the operator's "evidence + ledger" requires and the precondition for retiring
`opencode-workflow-guard` (Checkpoint D).

**Depends on:** W046 (task-command port), W050 (hub-http seam), W071 (standard-TUI authority), and
Phase G of `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`.

**Spec:** `docs/TASK_TODO_LEDGER_PARITY.md` — invariants I-1…I-10, kernel child nodes, evidence-bound
checkoff, immutable execution-log target, staged bridge→MCP migration, Phase-G retirement parity.
**V2 target:** `docs/OPENCODE_V2_MIGRATION_SPEC.md` — C/D and the native bridge now target the OpenCode
v2 HTTP API after qualification; no deeper v1 ACP expansion without a separately approved compatibility fix.
**Register:** `docs/COMPLIANCE_REGISTER.md` — DRIFT-001…024 obligations (strict compliance; no prose
promotions).
**Baseline:** `docs/PLAN_VS_REALITY_AUDIT.md`.

**Acceptance criteria:**
- [ ] **I-1** Mutations deny without an active canonical step on an `IN_PROGRESS` task (`NO_ACTIVE_STEP`),
      enforced at the application gate and mirrored in `workflow-guard-mcp`; test proves the deny.
- [ ] **I-2** Active steps cannot be silently deleted/omitted; test proves the block.
- [ ] **I-3** Step completion requires fresh typed evidence bound to the step (subject `step:<id>`);
      an agent cannot complete a step without an intervening authorized/observed action; test proves it.
- [ ] **I-4** A task/run cannot leave `IN_PROGRESS`/reach `VERIFIED` while any required step is open;
      a canonical `isRunComplete` predicate refuses completion with any required node open; tests prove both.
- [ ] **I-5** Secondary review audits the ledger against the diff/evidence; a checked step with no
      corresponding work yields a P0/P1 and `REQUEST_CHANGES`; pinned by a review test.
- [ ] **I-6** Immutable plan ledger + **append-only execution log**; canonical state is a deterministic
      replay/projection of the log (write/read only; permissions deterministic); restart resumes by replay.
- [ ] **I-7** Every step declares its done-condition before it can start; test proves an undeclared step cannot start.
- [ ] **I-8** At most one `IN_PROGRESS` step per task; test proves a second concurrent start is rejected.
- [ ] **I-9** Deterministic validation gates ordered codes→schema→cross-field→**state-diff re-query**→tests;
      an LLM only classifies; test proves a claimed-but-absent change is rejected.
- [ ] **I-10** Every execution-log entry carries durable identity (session/agent/task/step).
- [x] Stage 1 native-`todowrite` bridge keeps the agent's DX while the plugin remains the enforcement
      seat (per Phase G). Stage 2 hub-owned enforcement; Stage 3 portable MCP step tool; Stage 4 G6 corpus
      remain future stages.
- [ ] Drift obligations closed with linked evidence: in particular **DRIFT-003** (GUARD_CORPUS_MAP
      "Ported (superset)" overclaim), **DRIFT-004** (`workflow-fs-exec-mcp` dead `/before-tool` route),
      **DRIFT-008/009** (empty `requiredEvidence` escape, missing run-completion predicate),
      **DRIFT-001/002** (W050/Cline reconciliation, Checkpoint C evidence).
- [ ] Ledger checks folded into the G6 adversarial corpus; `opencode-workflow-guard` retirement only
      after the per-pinned-version criteria (a)/(b)/(c) pass — never date-gated.
- [ ] Focused gates pass (`npm run lint`, `npm run typecheck`, focused tests) and an independent
      five-axis review is recorded.

**Verification:** kernel/application tests for I-1…I-4, the `isRunComplete` test, the review-audit test,
the G6 corpus run for the pinned agent version, and the closed `docs/COMPLIANCE_REGISTER.md` rows with
their linking artifacts.

**Status (2026-09-20, Stage 1 bridge landed; C/D paused for OpenCode v2):** spec, audit, compliance register,
and v2 migration/qualification spec are committed. Stage 1 kernel/application work plus native ACP
`todowrite` bridge are implemented and reviewed **APPROVE**. Focused gates: typecheck/lint clean;
145/145 focused tests; `test/step-ledger.test.ts` now pins ledger, restore, done-condition, ownership,
and bridge behavior. **Still open:** all-surface enforcement, G6 corpus folding, immutable execution log,
state-diff evidence, v2 C/D reconciliation, and Phase-G probes. W072 remains **in progress**, not
complete.

**Addendum (2026-09-20, v2 host-version finding):** stock OpenCode **removed the `todowrite`/`todoread`
agent tools entirely in v2** (upstream `anomalyco/opencode#42421`, closed **not planned**; verified
on the pinned v2.0.10 binary — zero tool strings, zero HTTP todo routes; only adjacent experimental
surface is `instructions/entries`). Consequences: the native-todowrite bridge has **no agent-facing
input on the pinned OpenCode host version** (it remains valid for hosts that expose native todos —
goose/cline); the guard's todowrite gate can never be satisfied by a model on OpenCode v2, which
validates the earlier removal of the todo requirement from the workflow-guard plugin. Decision: do
NOT pivot tracking to `instructions/entries` (experimental, session-scoped, wrong semantics), and —
per the operator's no-plugins constraint — do NOT restore a todo tool via the v2 plugin API's
`ctx.tool.transform` (the richer v2 plugin surface is deliberately not adopted; see the constraint
recorded in project memory 2026-09-20). The canonical tracking surface is the Workflow step ledger —
surfacing it in the custom web UI is the accepted track; an upstream-candidate PR (§8) to restore a
generic todo tool is parked, and the interim advisory workaround is a plan file via
`WORKFLOW_ADVISORY_NOTES`. Recorded in project memory 2026-09-20.


## Phase 15: Bounded recursive self-improvement (2026-09-19)
