<!-- Ledger fragment: extracted from TASKS.md at line 166 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W008 - Implement UI/host-neutral application API

**Objective:** Expose canonical state and commands through a stable application service that both UIs and host adapters can consume.

**Depends on:** W007

**Acceptance criteria:**
- [ ] API exposes workflow snapshot, ready/blocked tasks, blockers, evidence state, host enforcement capabilities, and transition history.
- [ ] Commands are explicit intents; clients cannot write canonical state directly.
- [ ] State/event ordering is deterministic enough for multiple UI implementations.

**Verification:** Application contract tests exercise queries, commands, errors, and event projection without a UI framework.
