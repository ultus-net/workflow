<!-- Ledger fragment: extracted from TASKS.md at line 76 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W002 - Define kernel domain contracts

**Objective:** Define stable types for task identity/state, dependencies, artifacts, evidence, mutations, policy decisions, and state transition results before implementing orchestration.

**Depends on:** W001

**Acceptance criteria:**
- [ ] States include `BLOCKED`, `READY`, `IN_PROGRESS`, `VERIFYING`, `VERIFIED`, and `FAILED` with explicit semantics.
- [ ] Evidence identifies its subject and authority rather than exposing a generic `verified: boolean` contract.
- [ ] External/adapter inputs are distinguishable from trusted internal state.

**Verification:** Type-level/unit contract tests cover accepted variants and boundary validation.
