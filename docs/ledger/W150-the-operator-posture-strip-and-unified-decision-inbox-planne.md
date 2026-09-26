<!-- Ledger fragment: extracted from TASKS.md at line 5547 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W150 - The operator posture strip and unified decision inbox (Planned - Paperclip borrow wave 1; spec: docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md Wave 1) (2026-09-26)

**Source:** the Paperclip borrowings spec, mapping rows 1/2/9 (dashboard overview cards, approvals queue, watchdog recovery surfacing). Four posture counts above the two-region layout — runs awaiting review/decision, open budget incidents (W045/W118 tiers), orphaned runs needing recover-or-discard, schedules whose last run failed — above one decision list merging run-gate reviews, recorded review decisions, budget incidents, and orphaned-run recovery, each row with actor + authority basis + an action link into an existing panel.

**Acceptance criteria:**
- [x] Posture strip renders counts computed only from registry state; a fail-closed empty/degraded state when a registry is absent (focused test).
- [x] Zero mutations on render; every row's action is a link into an existing panel (no new write routes; test).
- [x] Decision-list coverage and attribution pinned by a focused projection-function test.
- [x] lint + typecheck + focused webapp tests green.

**Residuals (recorded, not built):** if the dashboard is ever served beyond loopback, the new action dispatch must be token-gated per the azure spec's Easy Auth track.

**Dated note (2026-09-27, landed — wave 1 complete):** the projection function
(`src/integrations/operator-posture.ts`) computes the four counts ONLY from
registry/kernel state: runs parked in VERIFYING with no recorded review
verdict (awaiting review), per-session budget incidents, orphaned runs, and
failed schedules grouped by the schedule-origin id — the three-segment
registry shape (`schedule:<id>:<uuid>`, hub-scheduler.ts) so reviewer runs
(`schedule:hub-reviewer-<uuid>`, one colon) never group into the schedule
count (pinned). Absent registries degrade with NAMED absences (per-session
budget state, orphaned-run detection, schedule registry, run-gate
observability) — never a fabricated zero — and emit no decision rows for
data the projection was never given. The decision list merges all four
kinds; actor + authority attribution comes from the record kind (agent /
reviewer / budget guard / system / scheduler), never synthesized; every
action is a LINK into an existing panel — zero new write routes. Wiring: the
hub's /snapshot gains the computed posture block; the web service gains
exactly ONE read route (`/api/posture` — the spec forbids a second
aggregation endpoint) proxying it fail-closed (no hub, or a pre-W150 hub,
answers `posture: null` + reason; the browser never sees a hub token); the
webapp renders the strip above the content regions
(`posture-strip.tsx`: counts, named degraded marks, the decision inbox).
Actions render as navigation buttons ONLY where an existing panel exists
today (schedules); run/session inspection panels do not exist yet, so those
rows carry the hub-served target in the title and no button — the recorded
wave-1 gap, not a dead link. Focused tests: test/operator-posture.test.ts
(7 — counts, the awaiting-review rule, degraded, attribution + links,
purity, lineage join + tombstone, the reviewer-id exclusion). Deliberately
deferred from tier B this PR: the test's `test:ci` inclusion would trip the
guard PR-preflight's lockfile heuristic (a manifest edit without a lockfile
diff — a scripts-only false positive, the same one that blocked the W156
lane's PR); its inclusion rides the next manifest-touching PR once that
heuristic is fixed.
