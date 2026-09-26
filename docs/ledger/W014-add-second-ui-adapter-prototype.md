<!-- Ledger fragment: extracted from TASKS.md at line 256 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W014 - Add second UI adapter/prototype

**Objective:** Prove presentation portability against the same application API.

**Depends on:** W012

**Acceptance criteria:**
- [ ] Second UI can render canonical state and submit at least one safe command without adding UI-specific state logic to core.
- [ ] Existing UI continues to work unchanged.

**Verification:** Manual/runtime smoke test plus application contract tests unchanged.
