<!-- Ledger fragment: extracted from TASKS.md at line 605 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W034 - Hub-side ACP subprocess session spike

**Objective:** Prove the hub can own ACP subprocess lifecycle and translate a bounded prompt/session flow through the wire layer without any TUI commitment.

**Depends on:** W033

**Acceptance criteria:**
- [x] A controlled fake ACP agent subprocess performs `initialize` and `session/new` over NDJSON stdio.
- [x] A prompt turn forwards `session/update` notifications as live projection events only.
- [x] Cancellation and process failure produce explicit terminal states without corrupting Workflow authority.
- [x] The spike is headless and does not bind the session stream to a terminal UI.

**Verification:** fake-agent subprocess integration tests covering initialize, session creation, prompt/update, cancellation, malformed output, and process exit.
