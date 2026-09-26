<!-- Ledger fragment: extracted from TASKS.md at line 468 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W026 - Workflow-owned coding task lifecycle

**Objective:** Connect an SDK coding session to Workflow's canonical decomposition, readiness, evidence, and verification model so a long coding request cannot be completed merely by model narration.

**Depends on:** W024, W025

**Acceptance criteria:**
- [x] Coding work is represented by canonical Workflow tasks with explicit dependencies and verification requirements outside model conversation state.
- [x] SDK tool proposals are correlated with the active eligible Workflow task; blocked work cannot mutate merely because the model requests it.
- [x] Successful tool execution does not itself mark a task verified; admitted evidence must satisfy the task's verification requirements.
- [x] Host-neutral application commands support controlled task/dependency creation for newly discovered prerequisites without exposing `TaskGraph` directly or allowing the model to bypass cycle, readiness, or transition validation.

**Verification:** multi-step coding fixture proves blocked dependency rejection, focused verification, evidence-driven unlocking, and final completion only after all required tasks are verified.

W026 is complete. `WorkflowApplication` exposes controlled task and dependency commands while `TaskGraph` continues to derive readiness and reject missing, duplicate, self, or cyclic dependency changes. Application regressions prove blocked canonical work cannot mutate, tool success alone cannot satisfy verification, and fresh environment evidence unlocks downstream work. The real Cline coding-session fixture exercises the authoritative `beforeTool` seam against a blocked implementation task, then proves prerequisite evidence unlocks that same canonical task and final completion occurs only after each task's required evidence is admitted.

### Checkpoint C - Usable Coding Prompt

- [x] An operator can give Workflow a normal coding request rather than individual shell commands.
- [x] A real SDK supplies the model/agent loop; Workflow does not duplicate that machinery.
- [x] The agent can inspect, edit, test, and iterate in a real disposable repository while Workflow authorizes consequential actions and containment remains observable.
- [x] The final response reflects independently verified repository state rather than model-only completion claims.
- [x] Failure/denial remains diagnosable and does not silently become advisory execution.

Checkpoint C is reconciled from the configured real-Cline coding fixture: the fixture submits a natural-language coding request through `WorkflowCodingSession`, uses the real SDK-owned agent loop, exercises repository inspection plus contained mutation and verification, independently checks the resulting Git diff and repository content, and separately proves an authoritative Workflow denial never reaches execution. `npm run test:cline-coding-session` remains the executable evidence for this checkpoint.

## Phase 7: Daily-Driver OpenCode Replacement
