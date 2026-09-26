<!-- Ledger fragment: extracted from TASKS.md at line 496 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W027 - Host-neutral coding session port

**Objective:** Normalize SDK session input/output at the application boundary before attaching the standalone TUI to Cline activity.

**Depends on:** W026

**Acceptance criteria:**
- [x] A host-neutral application port represents prompt submission, streaming assistant/session activity, normalized tool proposal/outcome events, cancellation, and terminal session state without exposing Cline/model-provider types to UI or kernel modules.
- [x] The Cline integration translates its SDK lifecycle into that port while Workflow application state remains the authority for tasks, policy, evidence, and enforcement state.
- [x] A fake session adapter can drive the same application-facing event contract in tests, proving the TUI need not depend directly on Cline.

**Verification:** application/session contract tests plus Cline translation tests; existing kernel/application contracts remain unchanged where no session concern is involved.

W027 is complete. `WorkflowCodingSession` owns the application-facing prompt, activity subscription, cancellation, and terminal-state contract while a replaceable `CodingSessionDriver` keeps SDK details outside UI and kernel modules. `ClineSessionDriver` translates Cline status, assistant text, normalized tool proposal/result, error, completion, and stop behavior through that contract, reusing `ClineHostAdapter` subject normalization without moving task/policy/evidence authority out of `WorkflowApplication`. Fake-driver tests prove host independence, Cline event fixtures cover translation and cancellation, and the real configured Cline coding fixture now runs through the same host-neutral session boundary.
