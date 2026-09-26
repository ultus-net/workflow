<!-- Ledger fragment: extracted from TASKS.md at line 103 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W004 - Implement evidence and invalidation engine

**Objective:** Bind verification to observable subjects and invalidate it when relevant state changes.

**Depends on:** W002, W003

**Acceptance criteria:**
- [ ] `VERIFYING -> VERIFIED` requires the task's declared evidence requirements to be satisfied.
- [ ] Evidence tracks authority, subject, result, observation identity/time, and freshness state.
- [ ] A relevant mutation makes dependent evidence stale and prevents stale evidence from satisfying completion.

**Verification:** Tests prove successful verification, missing evidence, failed evidence, and post-verification mutation invalidation.
