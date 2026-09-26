<!-- Ledger fragment: extracted from TASKS.md at line 527 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W029 - Session resume and long-context recovery

**Objective:** Make real coding sessions survive process/model context boundaries without treating conversation summaries as authoritative workflow state.

**Depends on:** W015, W026, W028

**Acceptance criteria:**
- [x] A persisted coding session can resume with task/evidence/journal authority restored from Workflow state; Workflow persists only canonical workflow/session correlation required for its authority, while conversation/context persistence uses SDK-native facilities as non-authoritative host state.
- [x] Interrupted `IN_PROGRESS`/`VERIFYING` work follows deterministic recovery rules before further mutations are authorized.
- [x] Context compaction, unavailable SDK conversation restoration, or model-session restart cannot erase unfinished canonical tasks or manufacture verification.

**Verification:** restart during a multi-task coding fixture, resume, re-observation where required, and successful completion without skipped work.

W029 is complete. Persisted Workflow state retains only canonical authority plus an opaque Cline session correlation; conversation history is restored from Cline through `readMessages` and is never canonical Workflow state. Orphaned `IN_PROGRESS` work recovers to `FAILED`, retry re-establishes readiness and authorization explicitly, unavailable correlated history fails closed, and `npm run test:cline-resume` proves restart-through-completion requires fresh post-restart evidence.
