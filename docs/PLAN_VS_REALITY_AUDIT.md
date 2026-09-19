# Plan-vs-Reality Audit — Drift Baseline

**Status:** Audit — 2026-09-19  
**Purpose:** This is the baseline evidence for *why* the Task & Todo Decomposition Ledger exists
(`docs/TASK_TODO_LEDGER_PARITY.md`). It exists to stop goals and work from drifting away from the plan
without operator approval. This audit found that drift is already present in the repo: claims, roadmap
checkboxes, and docs disagree with the code, and several "Complete" statements are not backed by
executable evidence.

**Method:** Read-only cross-scan of the planning documents against the code, in four passes:
kernel/application vs `llm-enhancements.md`; guard parity vs `GUARD_CORPUS_MAP.md` + hub-owned-enforcement
Phase G + `opencode-workflow-guard`; MCP toolbox wiring vs its docs; roadmap/UI status vs `TASKS.md`,
`docs/FEATURES.md`, `docs/TUI_PARITY.md`, `docs/web-ui-feature-tiers.md`.

Legend: **Drift** = doc/status claims diverge from code; **Missing** = required capability absent;
**Overclaim** = "Complete/Ported" not backed by executable evidence.

---

## 1. Drift classes found

### 1.1 Roadmap/status drift (highest priority)
| Finding | Evidence | Class |
|---|---|---|
| Cline retirement has mutually inconsistent truth sources: `TASKS.md` says removal is on an unmerged branch with criterion 4 pending; `FEATURES.md`/`OPENCODE_QUALIFICATION.md` describe it as current/merged; `HOST_ADAPTERS.md` still cites removed files/scripts | `TASKS.md:817-833`; `docs/FEATURES.md:50-51,64`; `docs/OPENCODE_QUALIFICATION.md:61-77`; `docs/HOST_ADAPTERS.md:63-65` | Drift |
| Checkpoint C is marked complete using a **deleted** verification path (`npm run test:cline-coding-session` no longer exists) | `TASKS.md:448-456` | Overclaim |
| W048 reads "Qualified/live" while the six-probe acceptance box is unchecked (Azure metering, subagent hook coverage open) | `TASKS.md:794`; `docs/FEATURES.md:57`; `docs/HOST_ADAPTERS.md:109` | Drift |
| W044–W047 marked Complete but live/dogfood verification deferred to W049, which is open | `TASKS.md:722-784`, `:802-815` | Drift |
| W071 code is extensive but every acceptance box is unchecked; surface correctly stays `advisory` pending live probes | `TASKS.md:880-919`; `docs/FEATURES.md:74`; `docs/OPENCODE_SERVER_AUTHORITY.md:331-334` | Missing (probes) |
| Roadmap numbering gaps: W052–W053, W055–W056, W058–W062, W065–W069, base W070 have no sections | `TASKS.md:845-871` | Drift |

### 1.2 Missing canonical capabilities (the ledger's target)
| Finding | Evidence | Class |
|---|---|---|
| **No canonical step/todo child level exists.** Kernel task states are only `BLOCKED/READY/IN_PROGRESS/VERIFYING/VERIFIED/FAILED`; `WorkflowStep` exists only on paper in the ledger spec | `src/kernel/contracts.ts:8-13`; `src/kernel/contracts.ts:36-42` | Missing |
| **No pre-mutation *step* gate.** The gate is active-*task* only (`TASK_NOT_IN_PROGRESS`); and hub surfaces auto-seed an `IN_PROGRESS` task with `requiredEvidence: []`, so a mutation can always authorize against an empty auto-created task | `src/application/workflow.ts:151-157`; `src/cli/hub.ts:34-42`; `src/integrations/hub-http.ts:35-40` | Missing |
| **No all-done / run-completion predicate.** No `isRunComplete` that requires every required task VERIFIED and none blocked/ready/in_progress/verifying/failed. Run `finish()` verifies one task | `src/kernel/task-graph.ts:245-257`; `src/integrations/run-registry.ts:274-389` | Missing |
| **Completion not bound to child steps.** `IN_PROGRESS→VERIFYING` checks only pedagogy checkpoints, not sub-steps | `src/application/workflow.ts:186-199` | Missing |
| **Weak completion evidence defaults.** Session/interactive/plain-run tasks carry `requiredEvidence: []`, so zero-evidence `VERIFIED` is legal; only review-gated runs bind reviewer + test evidence | `src/cli/hub.ts:40`; `src/cli/web-service.ts:43,50`; `src/integrations/opencode-server-authority.ts:111`; `src/integrations/run-registry.ts:227-232` | Overclaim risk |
| Evidence lacks a typed `type`/machine-readable `details` and is not bound to a postcondition (llm-enhancements.md §Evidence Should Be Typed) | `src/kernel/contracts.ts:16-34`; `src/adapters/mcp.ts:13-37` | Partial |

### 1.3 Guard/enforcement parity drift (blocks plugin retirement)
| Finding | Evidence | Class |
|---|---|---|
| `GUARD_CORPUS_MAP.md` claims "Task-list gating … **Ported (superset)**" but the decomposition pre-mutation gate, no-silent-deletion, and all-done gate are absent | `docs/GUARD_CORPUS_MAP.md:25` vs `src/application/workflow.ts:151-181` | Overclaim |
| Plugin Policy 1 (pre-edit todo gate, no silent deletion, subagent inheritance/mutation budget, concurrent file claims, stale-write fingerprints) has no hub equivalent | `opencode-workflow-guard/src/lib/guard-dispatcher.ts:256-285`; `src/policies/todo.ts:87-147` | Missing |
| Plugin Policy 10 (all-done verification gate blocking completion on a red build) has no hub equivalent; hub gates evidence only on review-gated runs | `opencode-workflow-guard/src/lib/guard-dispatcher.ts:159-193`; `run-registry.ts:227-232` | Missing |
| **G3 substitution is broken:** `workflow-fs-exec-mcp` posts `/before-tool`, a route the hub removed in W050 step 6 → 404 → permanent denial (fails closed, but criterion (a) unmet); stale citation remains | `mcp-toolbox/apps/workflow-fs-exec-mcp/src/hub-client.ts:81-97`; `docs/HUB_PROTOCOL.md:142-149`; `src/integrations/hub-http.ts:83-168` | Drift |
| Phase G retirement criteria unmet: (a) enforcement path / substitution, (b) corpus green per pinned version, (c) remaining surface ported or accepted gap — the step-ledger family is neither ported nor recorded as an accepted G6 gap | `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md:639-643` | Missing |
| W071 enforced posture unproven (live PERMISSION/RULE-CONFIG/BYPASS probes never ran; no model key) | `docs/OPENCODE_SERVER_AUTHORITY.md:331-334`; `docs/FEATURES.md:74` | Missing |

### 1.4 MCP toolbox composition drift
| Finding | Evidence | Class |
|---|---|---|
| Only 3 servers are actually composed by the control plane: `workflow-guard-mcp` (guard), `skills-mcp` (agent mounts), and the operator-configured generic catalog | `src/integrations/mcp-toolbox-guard.ts:51-135`; `src/integrations/opencode-agent-config.ts:114-121`; `src/integrations/goose-agent-config.ts:180-205` | Partial |
| `workflow-fs-exec-mcp` is **unwired** in `src/` (its hub route is dead); `egress-audit-mcp` is unwired; `project-memory-mcp` and `review-accountability-mcp` have client modules with **no callers** | `mcp-toolbox/apps/*`; `src/integrations/project-memory.ts:47-90`; `src/integrations/review-followups.ts:26-56` | Drift |
| No MCP server provides a task/step/todo mutation API — **by current design** (MCP never owns task state). A portable ledger tool would need a new ownership decision | `mcp-toolbox/PLAN.md:199-201`; `mcp-toolbox/docs/architecture/accountability-continuity-boundary.md:48,57-68` | Open decision |

### 1.5 UI/TUI parity drift
| Finding | Evidence | Class |
|---|---|---|
| Web lacks documented Tier 3 + monitoring: cross-session search, message feedback, ephemeral chat, system-prompt presets, run-gate verdicts / review follow-ups / blocking reasons | `docs/web-ui-feature-tiers.md:98-104`; `docs/FEATURES.md:70,100` | Missing |
| Web does not render `agent-context` rows though W047 is "Complete" | `docs/FEATURES.md:56` | Drift |
| `docs/DESIGN.md` still opens Cline-CLI-centric over newer web design | `DESIGN.md:3-12` | Drift |

---

## 2. Root cause

The repo's own principle (`llm-enhancements.md:31`): *"The LLM should not be able to declare an
invariant satisfied merely by emitting text saying that it is satisfied."* The audit shows the same rule
is violated by **human/agent-written prose** in the docs and roadmap:

1. **Status is prose, not executable.** "Complete"/"Ported" are strings; many are not pinned by a test that
   would fail when the claim becomes false (e.g. Checkpoint C's deleted verification command,
   `GUARD_CORPUS_MAP.md:25`).
2. **No canonical plan↔work linkage.** Nothing binds a roadmap item to the canonical tasks/steps that
   implement it, so work can drift and still be labelled done.
3. **Completion is not evidence-bound at the default surfaces.** Empty `requiredEvidence` makes
   zero-evidence `VERIFIED` legal outside review-gated runs.
4. **No run-completion / drift gate.** There is no predicate that refuses to call a plan complete while
   required work is unfinished, so "we did it" and "the graph says it is done" can disagree.

---

## 3. How the ledger + evidence resolves each drift class

| Drift class | Ledger/evidence control |
|---|---|
| Claim vs reality | Evidence-bound completion: a step/task cannot be `COMPLETED`/`VERIFIED` without fresh typed evidence at the right subject (`llm-enhancements.md` Verification Hook; ledger Invariants I-3/I-4) |
| Plan vs work | Canonical linkage roadmap→tasks→steps: the plan item is realized as canonical nodes; open steps block the parent task and the run completion gate (I-1/I-4; Missing `isRunComplete`) |
| Unapproved scope change | Dynamic discovery becomes a controlled kernel operation (block parent, add prerequisite, cycle-check, re-derive) instead of silent scope edits — with an operator-visible record (`llm-enhancements.md:148-161`) |
| Stale/overstated doc claims | Doc-claim executable checks: every "Complete/Ported" becomes a pinned test or an explicit `Partial`/hole; the audit's finding list is the first obligation set |
| Guard retirement drift | Phase G parity: ledger checks folded into the G6 adversarial corpus; no `enforced` label without per-version probe evidence |

---

## 4. Prioritized remediation

1. **Land the ledger controls** (spec `docs/TASK_TODO_LEDGER_PARITY.md`): kernel step child nodes,
   evidence-bound checkoff (I-3), pre-mutation step gate (I-1), all-done completion gate (I-4).
2. **Add the missing run/plan completion predicate** (`isRunComplete`) so "done" is graph-derived, not claimed.
3. **Harden completion evidence defaults** — stop creating session/interactive tasks with
   `requiredEvidence: []` where work is meant to be verified.
4. **Fix or retire `workflow-fs-exec-mcp`** (dead `/before-tool` route) and reconcile
   `GUARD_CORPUS_MAP.md:25`'s "Ported (superset)" overclaim.
5. **Reconcile W050/Cline status** across `TASKS.md`, `FEATURES.md`, `HOST_ADAPTERS.md`,
   `OPENCODE_QUALIFICATION.md`; replace Checkpoint C's deleted verification with the ACP/OpenCode path.
6. **Wire the stranded MCP clients** (project-memory, review-accountability, verification-accountability)
   or record them as explicitly unwired.
7. **Make status executable** — convert the highest-risk "Complete/Ported" claims into pinned tests
   (the ledger's proof obligations).

---

## 5. Sources

`llm-enhancements.md`; `PRODUCT.md`; `TASKS.md`; `docs/FEATURES.md`; `docs/GUARD_CORPUS_MAP.md`;
`docs/HUB_PROTOCOL.md`; `docs/OPENCODE_SERVER_AUTHORITY.md`; `docs/OPENCODE_QUALIFICATION.md`;
`docs/HOST_ADAPTERS.md`; `docs/TUI_PARITY.md`; `docs/web-ui-feature-tiers.md`;
`docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`; `mcp-toolbox/PLAN.md`,
`mcp-toolbox/ROADMAP.md`, `mcp-toolbox/docs/architecture/accountability-continuity-boundary.md`;
`opencode-workflow-guard/docs/policies.md`, `src/policies/todo.ts`, `src/policies/completion.ts`,
`src/lib/guard-dispatcher.ts`; and the code paths cited inline.