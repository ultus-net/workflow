<!-- Ledger fragment: extracted from TASKS.md at line 5581 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W153 - Schedules as routines with per-schedule run lineage and origin attribution (Planned - Paperclip borrow wave 4; spec Wave 4) (2026-09-26)

**Source:** Paperclip routines (scheduled trigger creates a run with originKind attribution; per-routine run history), mapped onto W074 schedule-registry + hub-scheduler + schedules-view. The gap is the origin link and per-schedule history, not trigger mechanics: schedules-view gains last-run outcome, caused-run count with links, next fire, and a recent-runs filter; run rows anywhere carry "fired by schedule S" origin attribution. If the run registry lacks a schedule-origin field, the change lands in the hub integration layer first (schedule-registry.ts / run-registry.ts), view projects it — never the kernel.

**Acceptance criteria:**
- [ ] A schedule's caused runs and outcomes are registry-sourced, not UI-computed from timestamps (focused test).
- [ ] Run-now stays the only manual trigger path and records origin attribution.
- [ ] Deleting a schedule tombstones its origin rather than dangling historical runs (asserted).

**Residuals (cut):** webhook triggers, variable templating, concurrency/catch-up policies, revision history with restore, cron-picker editor.
