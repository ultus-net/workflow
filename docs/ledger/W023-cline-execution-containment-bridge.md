<!-- Ledger fragment: extracted from TASKS.md at line 418 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W023 - Cline execution-containment bridge

**Objective:** Extend the existing `createWorkflowClinePlugin`/Cline hook integration with a supported SDK execution seam so process actions authorized by Workflow execute through `WorkflowContainedProcess` rather than Cline's ambient native executor.

**Depends on:** W022

**Acceptance criteria:**
- [x] Current Cline SDK/runtime APIs are used to identify a supported execution seam; Workflow does not implement a parallel model, shell, or tool loop to obtain containment.
- [x] A Cline process proposal is authoritatively intercepted and the exact authorized executable/arguments are bound into `WorkflowContainedProcess` before real Bubblewrap execution.
- [x] The result is returned through the SDK's normal tool-result lifecycle so the host/model can continue without treating Workflow as the conversation runtime.
- [x] If the installed/current Cline SDK cannot replace or delegate native process execution at an authoritative seam, the integration fails closed and the limitation is recorded rather than claiming containment from `beforeTool` authorization alone.

**Verification:** real Cline runtime integration test for authorization -> Workflow-contained execution -> SDK-visible result, plus existing adapter/containment gates and independent review of the execution binding.

W023 is complete against the installed `@cline/core` 0.0.82 public `ShellExecutor`/`createShellTool` seam. The runtime regression exercises the real Cline shell tool around Workflow's injected executor and real Bubblewrap containment, including SDK-visible success, working-directory semantics, and nonzero-command failure semantics.
