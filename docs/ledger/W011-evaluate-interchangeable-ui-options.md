<!-- Ledger fragment: extracted from TASKS.md at line 207 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W011 - Evaluate interchangeable UI options

**Objective:** Present concrete UI choices after the application contract is runnable, without binding Workflow to one rendering technology prematurely.

**Depends on:** W008

**Acceptance criteria:**
- [ ] Compare at least a browser UI, standalone TUI, and host-native UI option for portability, interaction quality, maintenance, and packaging.
- [ ] Provide runnable/prototype evidence where evaluation needs it.
- [ ] User selects the first UI before production implementation begins.

**Verification:** Decision is captured with rationale and does not alter kernel/application contracts.
