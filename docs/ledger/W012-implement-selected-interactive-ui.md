<!-- Ledger fragment: extracted from TASKS.md at line 220 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W012 - Implement selected interactive UI

**Objective:** Give the user a real interactive Workflow surface backed only by the application API.

**Depends on:** W011

**Acceptance criteria:**
- [ ] User can see task DAG/state, current/ready/blocked work, blocker reasons, host enforcement level, evidence, and recent transitions.
- [ ] User can perform appropriate interactive commands/approvals without bypassing application authorization.
- [ ] Empty, loading, error/disconnected, and advisory-host states are explicit.
- [ ] UI is keyboard-accessible and works at its intended desktop/mobile or terminal sizes.

**Verification:** UI tests plus real runtime/browser or terminal interaction testing as appropriate.

## Checkpoint B - Usable Interactive Workflow

- [ ] A user can launch the selected UI and inspect a live Workflow session.
- [ ] A real host adapter can propose work through Workflow.
- [ ] MCP evidence appears through the same canonical state projection.
- [ ] UI cannot bypass kernel decisions.

## Phase 4: Prove Replaceability
