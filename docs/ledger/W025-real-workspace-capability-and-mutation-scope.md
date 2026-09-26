<!-- Ledger fragment: extracted from TASKS.md at line 451 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W025 - Real workspace capability and mutation scope

**Objective:** Replace the disposable all-session writable directory assumption with explicit repository-scoped authority suitable for normal coding work.

**Depends on:** W024

**Acceptance criteria:**
- [x] A coding session can read the intended repository while writes are confined to explicitly authorized workspace paths and ambient filesystem access remains unavailable by default.
- [x] Workflow can distinguish ordinary repository mutation from process, credential, network, and out-of-workspace capabilities without relying on model intent text.
- [x] Host-native file mutations outside the authorized repository/workspace are denied by deterministic path policy; OS-level filesystem confinement is claimed only for execution paths actually routed through the containment backend.
- [x] Attempted contained-process writes outside the authorized repository/workspace fail closed and are covered by runtime tests.
- [x] Existing user changes in a dirty worktree are observable and are not silently reverted or overwritten by Workflow lifecycle machinery.

**Verification:** disposable clean/dirty repository fixtures exercise permitted edits, denied path escape, process execution, and unchanged containment/credential/network boundaries.

W025 is complete. `WorkflowApplication` now optionally owns an absolute workspace root and deterministically rejects lexical and symlink-mediated path escapes for host-native proposals. Cline exposes batched read and patch target paths to that authority, while `WorkflowContainedProcess` subjects its working directory and readable/writable grants to the same policy before Bubblewrap execution. Runtime coverage proves escaped grants fail closed, ambient filesystem/credential/network boundaries remain enforced, a real dirty Git fixture retains its pre-existing user edit, and the real Cline coding-session fixture runs with Workflow's repository authority enabled.
