# Task & Todo Decomposition Ledger — Deterministic Enforcement & Plugin Retirement Parity

**Status:** Proposed Architecture & Roadmap Specification  
**Governing Principles:** `llm-enhancements.md`, `PRODUCT.md`, `THREAT_MODEL.md`, `AGENTS.md`  
**Related Plans:** `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md` (Phase G), `docs/GUARD_CORPUS_MAP.md` (Policy 1, 10, 24), `TASKS.md` (W046, W071, Checkpoint D)

---

## 1. Executive Summary & Problem Statement

Workflow's primary mission is to provide an in-process, SDK-agnostic deterministic control plane for coding agents (`PRODUCT.md`). A central requirement for qualifying the Workflow control plane as the operator's daily driver and retiring the legacy `opencode-workflow-guard` plugin (`TASKS.md` Phase 11 / Checkpoint D) is achieving **full deterministic parity** with the plugin's task and verification discipline.

In the current codebase:
- **Canonical Tasks** exist in the kernel (`src/kernel/task-graph.ts`) with strict evidence-gated state transitions (`READY`, `IN_PROGRESS`, `VERIFYING`, `VERIFIED`, `BLOCKED`, `FAILED`).
- **Interactive Decomposition** was initiated in W046 (`src/application/task-commands.ts`), but model-proposed decomposition remains purely advisory (the ACP `plan` projection), carrying zero canonical enforcement.
- **The Legacy Plugin (`opencode-workflow-guard`)** currently acts as the host-level enforcement seat: its Policy 1 blocks file-editing tools (`edit`, `write`, `apply_patch`, shell redirects) unless an active todo list exists in OpenCode's native todo system (`todowrite`); it blocks silent task deletion, enforces sequential progression/focus, triggers bounded continuation on idle, and enforces an all-done verification gate (Policy 10) before tasks can complete.

**The Architectural Mandate:**  
The agent must break larger tasks originating from a plan or roadmap down into canonical tasks, and tasks into bite-sized, trackable todo items. This creates an authoritative ledger the agent must work against before it can mark work done. The workflow guard must block the agent from advancing or mutating files if it attempts to skip steps or bypass the ledger. Secondary reviewers must verify that the agent did not cheat by self-certifying steps without actual evidence.

**This cannot be left to prompt instructions or model self-discipline.** As established in `llm-enhancements.md`:
> *"LLM behavior remains probabilistic... Repeating an invariant more emphatically in a prompt can reduce these failures but cannot make the invariant deterministic... The LLM should not be able to declare an invariant satisfied merely by emitting text saying that it is satisfied."*

This document defines the deterministic three-level decomposition ledger, the enforcement architecture across the kernel, application gate, and MCP toolbox, and the staged migration path required to retire `opencode-workflow-guard`.

---

## 2. The Three-Level Decomposition Model

```text
Level 1: ROADMAP / PLAN
  └─ Durable project context (TASKS.md, ROADMAP.md, PLAN.md, docs/plans/*)
     Discovered via project-context-mcp / guard_next_tasks.
     Defines strategic milestones, cross-session features, and architectural phases.

Level 2: CANONICAL TASKS (TaskGraph)
  └─ Governed by src/kernel/task-graph.ts & WorkflowApplication.
     Discrete units of verifiable work with typed dependencies and required evidence.
     Transitions: READY → IN_PROGRESS → VERIFYING → VERIFIED (or FAILED/BLOCKED).
     Correlated with the active authorization target (activeTaskCorrelation).

Level 3: CANONICAL STEPS / TODOS (StepLedger)
  └─ Kernel-owned child nodes bound to an IN_PROGRESS parent Task.
     Bite-sized, trackable execution steps generated during task decomposition.
     Transitions: PENDING → IN_PROGRESS → COMPLETED (or CANCELLED/BLOCKED).
     Enforced by application authorization, workflow-guard-mcp, and secondary review.
```

### 2.1 Level 1: Roadmap / Plan (Durable Context)
Strategic planning context lives in durable repository documentation:
- Root-level or `docs/` roadmaps and plans: `TASKS.md`, `ROADMAP.md`, `PLAN.md`, `docs/plans/*.md`.
- Discovered and surfaced through `project-context-mcp` (`discover_project_context`) and `workflow-guard-mcp` (`guard_next_tasks`).
- Supplies the agent with context for large initiatives without directly mutating execution state.

### 2.2 Level 2: Canonical Tasks (TaskGraph)
Tasks are the authoritative execution units in Workflow:
- Each task specifies an objective, dependencies, mutation scope, and required verification evidence.
- A task cannot enter `IN_PROGRESS` unless all prerequisites are `VERIFIED`.
- Mutations proposed by coding agents are authorized **only** when correlated with an `IN_PROGRESS` task (`TASK_NOT_IN_PROGRESS` / `UNKNOWN_TASK` fail-closed denials).
- A task cannot reach `VERIFIED` without fresh environment evidence (e.g. passing test execution, build artifact, or reviewer approval).

### 2.3 Level 3: Canonical Step/Todo Ledger (StepLedger)
To ensure the agent works in trackable, bite-sized steps:
- When a task enters `IN_PROGRESS`, the agent must decompose it into an ordered ledger of child steps/todos before non-trivial mutations are authorized.
- The step ledger is stored as first-class kernel state attached to the parent task (not unverified model prose).
- Each step defines a concrete sub-action, affected files/symbols, and expected postconditions.
- The agent must advance through the ledger sequentially or with explicit focus; skipping steps is prohibited.

---

## 3. Deterministic Invariants & Enforcement Gates

To guarantee that the agent stays "on the rails" without relying on prompt obedience, the following predicates are enforced in deterministic software logic:

### 3.1 Invariant I-1: Pre-Mutation Step Decomposition
Before any mutation tool (`edit`, `write`, `apply_patch`, or mutating shell command) is authorized:
```text
parent_task.status == IN_PROGRESS
AND has_active_step_ledger(parent_task)
AND active_step.status == IN_PROGRESS
```
If no step ledger has been initialized for the active task, or if all steps are in terminal states (`completed` / `cancelled`), mutating actions are **denied fail-closed** with error:
`NO_ACTIVE_STEP: Task <id> requires an in-progress step decomposition before mutations can proceed.`

### 3.2 Invariant I-2: No Silent Deletion & Monotonic Step Tracking
Each ledger update replaces or appends to the step list, but:
- An active step (`pending` or `in_progress`) **cannot silently disappear** from subsequent ledger submissions.
- Removing an active step without explicitly marking it `completed` or `cancelled` triggers an immediate policy rejection:
  `BLOCKED_STEP_MUTATION: Step '<title>' was removed without being marked completed or cancelled.`
- Steps cannot be marked `completed` out of order unless explicitly declared as independent concurrent steps.

### 3.3 Invariant I-3: Evidence-Bound Step Completion (No Self-Certification)
In accordance with `llm-enhancements.md`:
> *"The LLM should not be able to declare an invariant satisfied merely by emitting text saying that it is satisfied."*

Marking a step `completed` requires **per-step verification evidence**:
1. **Tool Observation:** At least one authorized mutating or verifying tool call must have executed and succeeded under the step's epoch.
2. **Typed Evidence:** For steps modifying code or configuration, fresh typed evidence must be recorded (e.g., successful typecheck, lint pass, syntax probe, or test execution at subject `step:<stepId>`).
3. An agent cannot transition a step to `completed` in the same turn it was created without observing an intervening authorized action.

### 3.4 Invariant I-4: All-Done Task Completion Gate
A parent task cannot leave `IN_PROGRESS` or transition to `VERIFYING` / `VERIFIED` until:
```text
all(step.status in ["completed", "cancelled"] for step in parent_task.steps)
AND count(step.status == "completed" for step in parent_task.steps) >= 1
AND fresh_verification_evidence_exists(parent_task)
```
If open steps remain:
`TASK_STEPS_OPEN: Cannot complete task <id>; steps [<step_ids>] remain pending or in-progress.`

### 3.5 Invariant I-5: Secondary Reviewer Anti-Cheating Audit
The independent secondary reviewer subagent (`src/review/rubric.ts`, `review-accountability-mcp`) evaluates work across the 5 core review axes. Under **Task Completeness** and **Test Integrity**:
- The reviewer inspects the step ledger alongside git diffs and test logs.
- If an agent marked steps `completed` without corresponding diff changes, or marked verification steps done without executing tests, the reviewer records a **P0/P1 finding** and issues a `REQUEST_CHANGES` verdict.

---

## 4. Architecture & Component Responsibilities

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Host Layer (OpenCode TUI / Web App / CLI)                               │
│ - Agent proposes decomposition via native todowrite OR Workflow MCP     │
│ - UI displays trackable steps, active task, and completion status       │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Workflow Application Layer (src/application/)                           │
│ - StepBridge: maps native todowrite <-> canonical kernel child steps   │
│ - TaskCommandPort: manages createTask, activateTask, completeTask       │
│ - WorkflowApplication.authorize: enforces Invariants I-1, I-2, I-4      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Kernel Layer (src/kernel/)                                              │
│ - TaskGraph: stores Task nodes and canonical Step child nodes           │
│ - State Machine: enforces legal transitions and dependency unlocking    │
│ - Mutation Epochs & Evidence Freshness: validates per-step evidence     │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Enforcement Seats (mcp-toolbox & Host Shims)                           │
│ - workflow-guard-mcp: evaluates guardCheck, shell-safety, evasion       │
│ - workflow-fs-exec-mcp: G3 substitution for non-cooperative agents      │
│ - review-accountability-mcp: 5-axis review anti-cheating audit          │
│ - LinuxBubblewrapContainment: OS-level containment boundary             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Kernel Extensions (`src/kernel/`)
- `WorkflowTask` contract expanded with `steps: readonly WorkflowStep[]`.
- `WorkflowStep` defines:
  ```typescript
  export interface WorkflowStep {
    readonly id: StepId;
    readonly taskId: TaskId;
    readonly content: string;
    readonly status: "pending" | "in_progress" | "completed" | "cancelled";
    readonly requiredEvidence?: readonly EvidenceRequirement[];
    readonly evidence?: readonly EvidenceId[];
    readonly createdAt: string;
    readonly completedAt?: string;
  }
  ```
- Task transition validators enforce that `IN_PROGRESS → VERIFYING` asserts all child steps are terminal.

### 4.2 Application Authority & Bridges (`src/application/`)
- **`StepLedgerBridge`**: Listens to agent decomposition calls (e.g. OpenCode's `todowrite` tool invocations or ACP `plan` events) and translates them into kernel `WorkflowStep` mutations on the active task.
- **`WorkflowApplication.authorize`**: Inspects the active task's step ledger on mutating proposals. Denies proposals if no step is `in_progress`.

### 4.3 MCP Toolbox Parity (`mcp-toolbox/`)
- `workflow-guard-mcp`: Incorporates Policy 1 step-tracking verification into `guard_check`.
- `verification-accountability-mcp`: Records evidence tied specifically to step identifiers (`step:<id>`).
- `review-accountability-mcp`: Enforces ledger audit rules in the 5-axis review rubric.

---

## 5. Migration Strategy & Plugin Retirement Criteria

In accordance with Phase G of `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`, `opencode-workflow-guard` is **not retired until full parity is proven**:

### Stage 1: Native Todo Bridge (Immediate DX Continuity)
- The agent continues to call OpenCode's native `todowrite` tool.
- The Workflow host adapter / server broker intercepts `todowrite` calls and synchronizes them to kernel `WorkflowStep` records.
- The existing `opencode-workflow-guard` plugin continues running as an in-process safety seat while control-plane parity is hardened.

### Stage 2: Hub-Owned Ledger Enforcement
- `WorkflowApplication.authorize` enforces Invariants I-1, I-2, and I-4 directly at the hub/gateway boundary.
- Even if an agent bypasses or disables the client-side plugin, the hub rejects unauthorized mutations when steps are open.

### Stage 3: Workflow MCP Task/Step Tool (Host-Agnostic Target)
- A portable MCP tool (`step_create`, `step_complete`, `step_list`) is published via `workflow-fs-exec-mcp` or a dedicated `workflow-task-mcp`.
- Any host (OpenCode, goose, Claude Code, custom ACP clients) interacts with the same canonical ledger over standard MCP.
- OpenCode's native `todowrite` becomes a secondary presentation projection.

### Stage 4: G6 Adversarial Corpus Verification & Retirement Gate
Before `opencode-workflow-guard` can be retired for a pinned agent version:
1. **Corpus Execution:** All Policy 1, 10, and 24 adversarial tests from `opencode-workflow-guard/test/test.mts` must execute and pass against the hub/control-plane implementation.
2. **Gated Live Probes:** Real-agent probes (`test/acp-opencode-ask-probe.test.ts`, `test/hub-scheduled-turn-probe.test.ts`, W071 server authority probes) pass live with recorded evidence.
3. **No Hidden Deltas:** Any unported behaviors (e.g. compaction hooks, specific ANSI-C evasion heuristics) are formally documented as accepted residuals in `docs/SECURITY_ASSURANCE.md` and `docs/GUARD_CORPUS_MAP.md`.
4. **Checkpoint D Signed Off:** The operator executes daily-driver dogfooding and signs off on `TASKS.md` Checkpoint D.
