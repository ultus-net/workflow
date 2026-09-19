# Compliance Register — Roadmap Goal & Drift Obligations

**Status:** Active register — 2026-09-19  
**Owner:** Operator (strict compliance)  
**Governing principle:** *"The model proposes. The harness validates. The environment provides evidence. Only validated evidence advances state."* (`llm-enhancements.md:211-218`)

This register exists because **goals and work drifted from the plan without operator approval**
(`docs/PLAN_VS_REALITY_AUDIT.md`). It turns that audit into tracked, closable obligations. A claim is
not "complete" until a deterministic check (a passing test, a probe verdict, or an operator sign-off)
pins it. Prose assertions do not close an obligation.

---

## 1. Roadmap goal (the compliance target)

Retire `opencode-workflow-guard` from daily use and run the **Workflow control plane + MCP servers**
instead, at full parity, by realizing the three-level decomposition ledger:

```text
ROADMAP / PLAN  →  CANONICAL TASKS  →  CANONICAL STEPS / TODOS
durable context     kernel TaskGraph     kernel child nodes (new)
```

Spec: `docs/TASK_TODO_LEDGER_PARITY.md`. Retirement criteria: `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md:639-643`
(per pinned agent version: (a) enforcement path/substitution live, (b) G6 corpus green, (c) remaining surface ported or explicitly accepted).

**Non-negotiables (invariants — compliance gates):**
- **I-1** No mutation without an active canonical step on an `IN_PROGRESS` task (`NO_ACTIVE_STEP`).
- **I-2** No silent deletion/omission of active steps.
- **I-3** Step completion requires fresh typed evidence bound to the step (no self-certification).
- **I-4** A task/run cannot complete while any required step/task is open (`isRunComplete`).
- **I-5** Secondary review audits the ledger against the diff/evidence; mismatch ⇒ `REQUEST_CHANGES`.
- **I-6** Immutable ledger + append-only execution log; canonical state is a deterministic replay/projection, never mutated in place as the sole source of truth (write/read only; permissions deterministic).
- **I-7** Every step declares its done-condition before it can start.
- **I-8** At most one step `IN_PROGRESS` per task (one entry per pass).
- **I-9** Completion validated by deterministic gates first (codes → schema → cross-field → state-diff re-query → tests); an LLM only classifies, never invents "done".
- **I-10** Every execution-log entry carries durable identity (session/agent/task/step).

---

## 2. Drift obligations

Status legend: **OPEN** (drifted, not closed) · **CLOSED** (evidence recorded) · **ACCEPTED** (operator-recorded residual).  
Severity: P0 (blocks retirement/authority) · P1 (major) · P2 (minor) · P3 (docs/nits).

| ID | Sev | Drift | Current evidence | Required evidence to close |
|---|---|---|---|---|
| DRIFT-001 | P1 | Cline/W050 truth-source contradiction (TASKS says branch-pending; FEATURES/QUALIFICATION say merged; HOST_ADAPTERS cites removed files) | `TASKS.md:817-833`; `docs/FEATURES.md:50-51,64`; `docs/OPENCODE_QUALIFICATION.md:61-77`; `docs/HOST_ADAPTERS.md:63-65` | One reconciled statement across all four docs + a passing current verification path |
| DRIFT-002 | P1 | Checkpoint C "Complete" via deleted `npm run test:cline-coding-session` | `TASKS.md:448-456` | Replacement ACP/OpenCode verification command, executed and recorded |
| DRIFT-003 | P0 | `GUARD_CORPUS_MAP.md:25` "Task-list gating … Ported (superset)" overclaim: no pre-mutation step gate, no silent-deletion gate, no all-done gate | `docs/GUARD_CORPUS_MAP.md:25` vs `src/application/workflow.ts:151-181` | Either the ledger gates land (I-1/I-2/I-4) and the corpus passes, or the row is downgraded to Partial + recorded gap |
| DRIFT-004 | P0 | `workflow-fs-exec-mcp` posted removed `/before-tool` route → 404 → permanent denial; G3 substitution was not live | historical `mcp-toolbox/apps/workflow-fs-exec-mcp/src/hub-client.ts:81-97`; `docs/HUB_PROTOCOL.md:142-149`; `src/integrations/hub-http.ts:83-168` | **Retired as superseded (commit `182da55`):** in-process ACP fs authorization is the live substitute; no dead standalone product remains. G3 substitution parity still requires its pinned adapter tests. |
| DRIFT-005 | P2 | W048 prose reads "Qualified/live" with an unchecked six-probe acceptance box | `TASKS.md:794`; `docs/FEATURES.md:57`; `docs/HOST_ADAPTERS.md:109` | Probe verdicts recorded, or wording capped to the proven OpenRouter mode |
| DRIFT-006 | P2 | W044–W047 "Complete" while live/dogfood verification deferred to open W049 | `TASKS.md:722-784`, `:802-815` | Distinguish "implemented" from "daily-driver verified"; close W049 or state the gap |
| DRIFT-007 | P3 | Roadmap numbering gaps (W052–W053, W055–W056, W058–W062, W065–W069, base W070) | `TASKS.md:845-871` | Define or explicitly retire each missing number |
| DRIFT-008 | P0 | Weak completion evidence defaults: session/interactive/plain-run tasks created with `requiredEvidence: []` ⇒ zero-evidence `VERIFIED` legal | `src/cli/hub.ts:40`; `src/cli/web-service.ts:43,50`; `src/integrations/opencode-server-authority.ts:111`; `src/integrations/run-registry.ts:227-232` | Evidence requirements enforced on work tasks (I-3/I-4); test proves zero-evidence completion is rejected |
| DRIFT-009 | P0 | No run/plan completion predicate (`isRunComplete`) — "done" is claimed, not graph-derived | `src/kernel/task-graph.ts:245-257`; `src/integrations/run-registry.ts:274-389` | Canonical predicate + test: refuses completion with any required node open |
| DRIFT-010 | P0 | No canonical step/todo child level exists (spec only) | `src/kernel/contracts.ts:8-13,36-42`; `docs/TASK_TODO_LEDGER_PARITY.md` | Kernel step nodes + evidence-bound checkoff + gates (I-1…I-4) landed with tests |
| DRIFT-011 | P2 | Stranded MCP clients: `project-memory-mcp`, `review-accountability-mcp`, `verification-accountability-mcp` built but unwired; `egress-audit-mcp` unwired | `src/integrations/project-memory.ts:47-90`; `src/integrations/review-followups.ts:26-56` | Wire into the session/verify/review path, or record explicitly as unwired |
| DRIFT-012 | P2 | Web UI lacks documented Tier 3/monitoring; `agent-context` (W047) not rendered web-side | `docs/web-ui-feature-tiers.md:98-104`; `docs/FEATURES.md:56,70,100` | Implement or downgrade the rows honestly |
| DRIFT-013 | P3 | `DESIGN.md` still Cline-CLI-centric over newer web design | `DESIGN.md:3-12` | Reconcile or mark superseded |
| DRIFT-014 | P1 | W071 stock-TUI surface `advisory`; live PERMISSION/RULE-CONFIG/BYPASS probes unrun | `docs/OPENCODE_SERVER_AUTHORITY.md:331-334`; `docs/FEATURES.md:74` | Probe family executed with per-probe verdicts; `enforced` only on green |
| DRIFT-015 | P1 | W054 durable-state attestation not wired to any production injection boundary | `TASKS.md:849-851`; `src/integrations/durable-state-attestation.ts:5-17` | Call at the first post-W050 memory-injection boundary + runtime test |
| DRIFT-016 | P0 | No append-only execution log; `TaskGraph` mutates state in place (state is the source of truth, not a replay projection) | `src/kernel/task-graph.ts:50-66,151-172`; no execution-log module found | Append-only, write/read-only execution log with deterministic replay; state projected from it; permissions enforced by the harness |
| DRIFT-017 | P1 | Steps can be defined without a declared done-condition; completion criterion not required before start | `src/kernel/task-graph.ts` `defineSteps`/`startStep` accept empty `requiredEvidence` | A step cannot start until it declares its completion criterion; test proves the block |
| DRIFT-018 | P2 | No single-active-step constraint (multiple steps may be `IN_PROGRESS`) | `src/kernel/task-graph.ts` `startStep` | Enforce ≤1 `IN_PROGRESS` step per task; test proves the second start is rejected |
| DRIFT-019 | P1 | No state-diff re-query gate (claimed change not re-observed in the target); reviewer is the only judge | `src/application/workflow.ts:166-182`; evidence model `src/kernel/contracts.ts:20-34` | Deterministic gate order codes→schema→cross-field→state-diff→tests; test proves a claimed-but-absent change is rejected |
| DRIFT-020 | P2 | Execution/evidence entries carry task but not a durable identity anchor on every entry | `src/kernel/contracts.ts:25-34`; `src/application/persistence.ts` | Identity (session/agent/task/step) recorded on each log entry; replay preserves attribution |
| DRIFT-021 | P0 | Corpus C not ported: no WorkflowApplication-owned per-session policy-failure counter/circuit-breaker | plugin `opencode-workflow-guard/src/lib/tool-outcomes.ts:26-95`; plugin enforcement `src/workflow-guard.ts:454-460` | Application-owned session/tool counter + deterministic threshold/decision + tests |
| DRIFT-022 | P0 | Corpus D not ported: no explicit read fingerprints/concurrent file claims | plugin `src/lib/guard-dispatcher.ts:268-285`; `ProposedToolAction` has no read-fingerprint/claim contract | Read-fingerprint record + matching write requirement + session/file claim lifecycle + tests |
| DRIFT-023 | P1 | Subagent mutation budget/inheritance not owned by Workflow session hierarchy | plugin `src/policies/todo.ts:26-35,53-85` | Parent-owned bounded budget inherited by descendants; exhaustion fail-closed; tests |
| DRIFT-024 | P2 | No deterministic state-diff re-query evidence gate | `src/kernel/contracts.ts:25-34`; evidence admission has no postcondition re-query contract | Add machine-observable postcondition/state-diff evidence contract and test |

---

## 3. Compliance rules (strict)

1. **No prose promotions.** A row moves from Partial/Planned to Complete/Ported only with a linked,
   passing deterministic check (test, probe verdict, or operator sign-off).
2. **Every "Ported/Complete" is a failing-when-false obligation.** Convert high-risk claims into pinned
   tests; a claim without a test is capped at Partial.
3. **Drift closure is evidence-linked.** Each DRIFT-## row records the closing artifact (commit/test/probe)
   in this register before it is marked CLOSED.
4. **Plan changes are operator-approved.** Scope/goal changes to the roadmap require an operator decision
   recorded here; model- or agent-proposed changes are advisory until confirmed.
5. **Retirement is probe-gated, never date-gated** (`docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md:629-643`).

---

## 4. Progress log (evidence-linked)

| Date | Obligation(s) | Increment | Evidence | Status effect |
|---|---|---|---|---|
| 2026-09-19 | DRIFT-009, DRIFT-010 (partial) | Kernel `WorkflowStep` child nodes + `isRunComplete`; I-2/I-3/I-4 gates; persistence; application step methods + conditional I-1 gate | commit `426c590`; `test/step-ledger.test.ts` (9); affected suites 105/105 | **Advanced, not closed.** DRIFT-009 predicate exists but is not yet enforced at all completion paths; DRIFT-010 still needs the native-`todowrite` bridge, all-surface enforcement, and G6 corpus. DRIFT-008 (empty `requiredEvidence` on session tasks) remains open. |
| 2026-09-19 | DRIFT-021 (partial) | WorkflowApplication-owned policy-failure tracker with plugin-parity threshold 2 and fail-closed `POLICY_CIRCUIT_BREAKER`; success resets the session state | commits `f379c51`, `c68f528`; `test/application-policy-failure-tracker.test.ts` (2) | **Advanced, not closed.** Host adapters still need to call `recordToolOutcome` for every denial/failure/success path before Corpus C is parity-complete. |
| 2026-09-19 | DRIFT-022 (partial) | Explicit `ReadFingerprint` proposal field, opt-in `requireReadFingerprint` host gate, `FileClaimLedger` digest/size/mtime matching, and exclusive session/file claims | commit `b55c7d0`; `test/file-claim-ledger.test.ts` (3) | **Advanced, not closed.** Native adapter read-fingerprint capture and full concurrent-claim lifecycle wiring remain open. |

---

## 5. Provenance

Derived from `docs/PLAN_VS_REALITY_AUDIT.md` (four-pass read-only scan) and `docs/TASK_TODO_LEDGER_PARITY.md`.
Tracking item: `TASKS.md` **W072**. Review cadence: re-scan before any Checkpoint D sign-off.