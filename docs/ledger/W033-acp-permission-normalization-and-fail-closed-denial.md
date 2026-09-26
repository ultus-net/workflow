<!-- Ledger fragment: extracted from TASKS.md at line 591 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W033 - ACP permission normalization and fail-closed denial

**Objective:** Normalize real ACP permission requests into the existing adapter/kernel path and encode denial using only valid ACP v1 outcomes.

**Depends on:** W032

**Acceptance criteria:**
- [x] A wire permission request is correlated with Workflow session/task context before reaching `AcpHostAdapter`.
- [x] A Workflow denial selects an agent-provided rejecting `optionId` when one exists.
- [x] When no rejecting option exists, the result explicitly requires fail-closed turn/session handling; the implementation never fabricates an option and never uses ACP `cancelled` as an ordinary denial.
- [x] Permission option `kind` is treated as a UI hint, not semantic proof.

**Verification:** focused unit tests for allow, deny-with-reject-option, deny-without-reject-option, malformed request, and UI-hint-only metadata cases.
