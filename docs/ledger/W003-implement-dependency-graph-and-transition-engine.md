<!-- Ledger fragment: extracted from TASKS.md at line 89 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W003 - Implement dependency graph and transition engine

**Objective:** Make task readiness and legal state transitions deterministic.

**Depends on:** W002

**Acceptance criteria:**
- [ ] Dependencies determine `BLOCKED`/`READY`; callers cannot manually unlock downstream tasks.
- [ ] Illegal transitions are rejected with stable machine-readable reasons.
- [ ] Self-dependencies, missing dependencies, and direct/transitive cycles are rejected.
- [ ] Adding a dependency can re-block affected downstream work.

**Verification:** Unit tests cover the legal transition table, dependency unlocking, graph mutation, and cycle/error cases.
