<!-- Ledger fragment: extracted from TASKS.md at line 268 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W015 - Persistence, recovery, and concurrent actor hardening

**Objective:** Preserve authoritative workflow state safely across restarts and competing sessions/agents.

**Depends on:** W007, W008

**Acceptance criteria:**
- [ ] Task graph, transition journal, and evidence survive restart without trusting model summaries.
- [ ] Transition writes use version/conflict semantics so two actors cannot silently advance the same task incompatibly.
- [ ] Orphaned `IN_PROGRESS`/`VERIFYING` recovery has deterministic rules.

**Verification:** Restart/crash fixtures and concurrent transition tests.

## Phase 5: Safety And Release Readiness
