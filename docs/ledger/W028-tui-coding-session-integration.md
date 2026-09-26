<!-- Ledger fragment: extracted from TASKS.md at line 511 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W028 - TUI coding-session integration

**Objective:** Make the selected standalone Workflow TUI the usable operator surface for the SDK-driven coding lifecycle proven at Checkpoint C.

**Depends on:** W027

**Acceptance criteria:**
- [x] The TUI accepts prompts, streams model/session activity, and displays proposed/authorized/denied tool activity without owning canonical workflow state.
- [x] Task readiness, blockers, evidence, enforcement/containment state, and verification outcomes remain inspectable during the coding session.
- [x] Cancellation, ordinary command/model failure, and session completion have explicit operator-visible states and do not corrupt canonical Workflow state.
- [x] Terminal interaction remains keyboard-accessible and usable for routine repository work.

**Verification:** real terminal interaction tests plus controlled SDK coding session through the TUI and unchanged application/kernel contract tests.

W028 is complete. The TUI accepts an injected host-neutral `WorkflowCodingSession`, has explicit prompt-entry and cancellation controls, and renders bounded status/assistant/tool/completion/failure activity alongside canonical task, blocker, evidence, enforcement, and history projections. Component and PTY tests cover streaming, cancellation, keyboard interaction, and canonical-state separation, while the standalone CLI composes the configured Cline runtime rather than introducing a second provider contract.
