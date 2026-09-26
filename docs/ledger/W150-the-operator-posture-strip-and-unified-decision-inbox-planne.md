<!-- Ledger fragment: extracted from TASKS.md at line 5547 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W150 - The operator posture strip and unified decision inbox (Planned - Paperclip borrow wave 1; spec: docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md Wave 1) (2026-09-26)

**Source:** the Paperclip borrowings spec, mapping rows 1/2/9 (dashboard overview cards, approvals queue, watchdog recovery surfacing). Four posture counts above the two-region layout — runs awaiting review/decision, open budget incidents (W045/W118 tiers), orphaned runs needing recover-or-discard, schedules whose last run failed — above one decision list merging run-gate reviews, recorded review decisions, budget incidents, and orphaned-run recovery, each row with actor + authority basis + an action link into an existing panel.

**Acceptance criteria:**
- [ ] Posture strip renders counts computed only from registry state; a fail-closed empty/degraded state when a registry is absent (focused test).
- [ ] Zero mutations on render; every row's action is a link into an existing panel (no new write routes; test).
- [ ] Decision-list coverage and attribution pinned by a focused projection-function test.
- [ ] lint + typecheck + focused webapp tests green.

**Residuals (recorded, not built):** if the dashboard is ever served beyond loopback, the new action dispatch must be token-gated per the azure spec's Easy Auth track.
