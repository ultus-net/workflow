<!-- Ledger fragment: opened 2026-09-30 as the P4 surface-journal view + per-session stamp record (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — the surface journal RENDERED in the run detail view + per-session provenance granularity (Landed — the provenance-stamped surfaceUsage observations now render as a distinct, honestly labelled section; the web-service surface stamps `surface:web-service:<sessionId>`; issue #283 stays OPEN for the hub-authoritative binding) (2026-09-30)

**Source:** GitHub issue #283. Predecessor: the topology A1 record
(`docs/ledger/topo-a1.md`, branch `feat/topo-a1`), which landed the
observability-only `/usage/record` route, the separate surface journal, and the
`surface:<surface>` stamp, and named two residual boundaries this slice closes:
**the webapp does not yet render the surface journal**, and **the stamp is
`surface:<surface>` because no stable session id was supplied at the
composition point**.

**What landed (branch `feat/p4-surface-view`):**

- **The view mirror.** `src/ui/webapp/runs-record.ts` gains
  `SurfaceUsageSummaryView` (the registry's `SurfaceUsageSummary` shape, field
  for field, including `recordedBy`) and the `runs.surfaceUsage` field. The
  relay already carried the journal from `/snapshot`'s gate-observability and
  runs blocks; the view simply mirrors it, derives nothing.
- **The distinct, labelled section.** `src/ui/webapp/run-detail-panel.tsx`'s
  Cost tab renders a separate **"Surface observations (not canonical
  attribution)"** section under the canonical "Per-task attribution". Each
  entry renders VERBATIM: its provenance stamp, the task id the SURFACE posted
  (labelled "observed task"), the posted numbers, and the recording time — with
  its own `run-surface-usage` class. A boundary line states the journal is
  hub-wide and its observations are relayed through the observability-only
  `/usage/record` route, **never merged into the canonical per-task attribution
  above** (the W153 client-never-supplies-attribution principle made legible).
- **The join is the same exact recorded-task id, kept deliberately.**
  `surfaceUsageForRun` selects entries whose recorded `taskId` equals the run's
  canonical `run:<id>` — the same exact join the canonical selector uses. A
  surface observation naming no canonical run task is not claimed by any run
  panel; it stays in the hub's surface journal (its honest home), rather than
  being attributed to a run that did not record it. This is stated in the
  section's named-absence line, not hidden.
- **Per-session provenance granularity.** `src/integrations/task-usage.ts`
  gains `surfaceStamp(surface, sessionId?)`: `surface:<surface>` when no stable
  session id exists at the composition point, `surface:<surface>:<sessionId>`
  when one does. The mandatory `surface:` prefix and the rule that a posted
  canonical taskId is never trusted as authoritative are unchanged — the hub's
  `/usage/record` still class-checks only the prefix, so a per-session stamp
  remains a labelled observation.
  - **Web service — a stable id exists, so it is stamped.**
    `WebSessionManager`'s runtime factory now receives the session's STABLE
    registry id as an additive fourth parameter (`src/ui/web-sessions.ts`);
    `src/cli/web-service.ts` stamps
    `surfaceStamp("web-service", sessionId)` →
    `surface:web-service:<sessionId>`. The web service is the one surface whose
    composition point holds a session identity (its registry record).
  - **The per-process TUIs — no stable id, recorded why.** `acp-tui`,
    `driver-registry`, and `ink-tui` compose ONE runtime per process and are
    handed no session identity at composition time; `driver-registry` is keyed
    by agent KIND, not a session. Their stamps stay `surface:acp-tui` /
    `surface:driver-registry` / `surface:ink-tui`. Naming a session there would
    fabricate identity, so the surface alone is named. (`runtime.driver
    .agentSessionId()` exists only AFTER connect, so it is not available at the
    composition point; using it would need a post-connect re-stamp the sink
    does not have.)

**Pins (red-first):**

- `test/surface-usage.test.ts` (1 new pin): `surfaceStamp` composes the
  per-session stamp with the mandatory prefix, and the hub records a
  `surface:web-service:<sessionId>` observation verbatim while the canonical
  `taskUsage` journal stays untouched.
- `test/webapp-runs.test.ts` (1 new pin, + `fullRunsRecord` fixture grows the
  `surfaceUsage` journal with a per-session stamp and a second run's entry): the
  surface journal renders in its OWN labelled section with its provenance stamp
  and posted numbers verbatim, stays distinct from the canonical per-task
  section (own class, boundary line), never claims another run's observation
  (exact `run:<id>` join), and names its empty/absent states.
- `test/web-sessions.test.ts` (1 new pin): the manager hands the factory the
  session's stable registry id — the per-session provenance key's source.

**Evidence (verbatim):**

- Red-first, `src/` unmodified against the new tests:
  `node --import tsx --test test/surface-usage.test.ts` →
  `# SyntaxError: The requested module '../src/integrations/task-usage.js' does not provide an export named 'surfaceStamp'`
  / `not ok 1 - test/surface-usage.test.ts` / `# tests 1 / # pass 0 / # fail 1`.
  `test/webapp-runs.test.ts` →
  `# SyntaxError: The requested module '../src/ui/webapp/run-detail-panel.js' does not provide an export named 'surfaceUsageForRun'`
  / `not ok 3 - test/webapp-runs.test.ts`.
  `test/web-sessions.test.ts` →
  `not ok 2 - the manager passes the session's stable registry id to the factory (per-session surface provenance)`
  / `AssertionError ... + undefined / - 'web-…'` (the factory received no
  session id).
- Green after the implementation:
  `node --import tsx --test test/surface-usage.test.ts test/webapp-runs.test.ts test/web-sessions.test.ts`
  → **52/52 pass, 0 fail**.
- Focused battery (task-usage + web-service + e2e-web-service +
  web-agents-endpoints + hub-snapshot + webapp-surface + web-operator-surfaces)
  → **66/66 pass, 0 fail, 0 skipped**; (web + web-scoping + web-budget-posture +
  hub-runs) → **73/73 pass, 0 fail, 0 skipped**. **191 focused, 0 fail.**
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Boundaries (remains):**

- **The hub is still not the attribution authority.** A1 records a labelled
  surface observation; Option A2 (hub-issued session nonce + hub-side
  session→task bind) and Option C stay OPEN. The per-session stamp improves
  *provenance legibility*; it is NOT a hub-verified session→task binding, and
  the hub still does not own the binding (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md`
  §2.1 A2, §5).
- **The per-run join cannot surface a surface observation that names no
  `run:<id>` task.** Interactive surfaces (web-service sessions, the TUIs) post
  the task their OWN active pointer holds — generally not a run task — so their
  observations stay in the hub's surface journal and render only when they name
  the run's canonical task. The named-absence line states this; a hub-wide
  surface page (or a session→run bind, A2) is the record change that would make
  every observation run-attributable.
- **The 64-slot surface journal's cross-lane eviction residual is unchanged**
  (`docs/ledger/topo-a1.md`, `docs/ledger/P4-sink-view.md:112-125`).
- **Issue #283 stays OPEN** — the view now renders the journal and the stamp
  carries per-session granularity where one exists, but the hub-authoritative
  attribution choice and the A2/C binding remain.
