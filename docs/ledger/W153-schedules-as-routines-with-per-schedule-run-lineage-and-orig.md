<!-- Ledger fragment: extracted from TASKS.md at line 5581 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W153 - Schedules as routines with per-schedule run lineage and origin attribution (Planned - Paperclip borrow wave 4; spec Wave 4) (2026-09-26)

**Source:** Paperclip routines (scheduled trigger creates a run with originKind attribution; per-routine run history), mapped onto W074 schedule-registry + hub-scheduler + schedules-view. The gap is the origin link and per-schedule history, not trigger mechanics: schedules-view gains last-run outcome, caused-run count with links, next fire, and a recent-runs filter; run rows anywhere carry "fired by schedule S" origin attribution. If the run registry lacks a schedule-origin field, the change lands in the hub integration layer first (schedule-registry.ts / run-registry.ts), view projects it — never the kernel.

**Acceptance criteria:**
- [ ] A schedule's caused runs and outcomes are registry-sourced, not UI-computed from timestamps (focused test).
- [ ] Run-now stays the only manual trigger path and records origin attribution.
- [ ] Deleting a schedule tombstones its origin rather than dangling historical runs (asserted).

**Residuals (cut):** webhook triggers, variable templating, concurrency/catch-up policies, revision history with restore, cron-picker editor.

**Dated note (2026-09-27, partial — the registry slice landed with wave 1's PR):** the
lineage projection (`scheduleLineage` in `operator-posture.ts`) joins caused
runs on the registry id prefix (`schedule:<id>:<uuid>`; the three-segment
shape excludes reviewer runs), takes the last outcome from the kernel
snapshot's insertion order (registry-structural, never timestamps), and
tombstones deleted schedules so their runs stay attributed rather than
dangling — pinned in test/operator-posture.test.ts (criteria 1 and 3's
registry-sourcing + tombstone halves, at the projection level). NOT yet
landed: the schedules-view rendering of the lineage (caused-run counts, the
recent-runs filter), and run-now's explicit origin-field recording
(run-now's runIds already carry the `schedule:` prefix, so attribution is
structural — the explicit origin field is still open). The view slice is
the remaining wave-4 work.

**Dated note (2026-09-27, wave-2 PR — the view slice landed):** the remaining
wave-4 work landed. The run registry records an explicit origin (a new
`RunOrigin {kind: "schedule", scheduleId}` stated by the scheduler at begin —
both cron fires and run-now flow through the same `fireOnce`, so every
scheduler-caused run is attributed from a RECORD; the HTTP `/run/begin` route
deliberately accepts no origin, since a client-supplied one would be forgeable
attribution) and relays it through `/snapshot`'s gate observability. The
hub's `/schedule/list` now carries per-entry lineage (the shared
`scheduleLineage` projection over the kernel's run states — never timestamps)
plus a `recentRuns` list (the new `scheduleRecentRuns`: last-N schedule-origin
runs in snapshot insertion order, newest first, tombstoned schedules
attributed by registry id); the web service relays it verbatim and the
schedules view renders the caused-run count, last outcome, next fire, and the
recent-runs section with "fired by <schedule>" attribution — an honest
absence from a hub predating the slice. Criteria 1 and 3 were already pinned
at the projection level (the 2026-09-27 registry slice); criterion 2's
run-now-only rule is unchanged (the browser's run-now stays CLI-only by
design — verifier credential, never the browser token). Residual: the
lineage's caused-run LINKS render as the posture inbox's recorded
"panel pending" pattern (no run-inspection panel exists yet), and the new
focused suites' `test:ci` inclusion rides the manifest-touching PR after the
preflight false positive is fixed.
