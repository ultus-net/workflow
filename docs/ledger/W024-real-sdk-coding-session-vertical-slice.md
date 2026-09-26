<!-- Ledger fragment: extracted from TASKS.md at line 434 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W024 - Real SDK coding-session vertical slice

**Objective:** Accept one natural-language coding request through the existing Cline SDK integration and prove that the SDK's consequential tool activity is governed by Workflow without a hand-built model/tool loop.

**Depends on:** W023

**Acceptance criteria:**
- [x] A real Cline model session can receive a natural-language coding request against a disposable Git repository and inspect the repository through its normal coding-agent lifecycle.
- [x] Every mutation/process action exercised by the slice is normalized by the concrete Cline adapter and must receive Workflow authorization before execution; process execution crosses the W023 containment bridge.
- [x] The SDK uses observed tool results to continue the same model session, produces a bounded code change, runs its verification, and returns a final response while Cline continues to own model streaming, conversation history, and its native agent loop.
- [x] The resulting repository state and verification result are independently observable in a controlled runtime test; model narration alone cannot satisfy completion.
- [x] The slice fails closed when authoritative host interception, containment, required credentials, or another required runtime capability is unavailable rather than silently downgrading the guarantee.

**Verification:** controlled disposable-repository coding task through the real Cline SDK runtime, resulting Git diff and verification evidence inspection, full existing gates, and independent review.

W024 is complete against installed `@cline/core` 0.0.82. `npm run test:cline-coding-session` starts a real local `ClineCore` model session using the operator's configured Cline provider, gives it a natural-language task in a disposable Git repository, observes Cline `read_files`/`run_commands` lifecycle traffic, and routes command execution through the Workflow-backed `ShellExecutor` and real Bubblewrap containment. The regression requires the model to run `git diff --check`, then independently checks the resulting tracked-file diff and content rather than accepting the model's completion claim. Missing Cline/provider configuration fails the runtime test instead of substituting an advisory or mocked session.
