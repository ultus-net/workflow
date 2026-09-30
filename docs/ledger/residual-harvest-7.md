<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-7 subtask, working the wave's remaining recorded nits. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 7 — the wave's remaining recorded nits (2026-09-30)

**Source:** the recorded five-axis-review items from the 2026-09-30 wave's
ledger fragments and `guard_review_followups`. This subtask works the brief's
list: fix what is small + testable (red-first where behavior/pins change),
record the rest. Branch `feat/harvest-7` off `origin/main` (`77702361`). No
item in this pass changed behavior or a pin, so there is **no red-first
capture** — every change is a documentation correction or a source comment.

**What landed (per item):**

1. **The harvest-6 P3 — the ledger's "byte-identical" wording for the
   unreachable `/board/delegate` `DuplicateRunError` branch — CORRECTED
   (docs-only; dated correction note appended to `residual-harvest-6.md`).**
   The harvest-6 record's item 1 said "Behavior is byte-identical: same
   statuses, same `{ error: <message> }` bodies" for the `sendClientFault`
   helper at "all FIVE `WorkspaceDeclarationError` sites". That is accurate for
   the reachable behavior but overstated if read as "the 409
   `DuplicateRunError` arm fires at each site". It does not:
   - `/run/begin` — calls `context.runController.begin` (`hub-http.ts:339`), so
     a duplicate active `runId` throws `DuplicateRunError` → 409. Reachable.
   - `/board/delegate` — also calls `begin` (`hub-http.ts:609`) but under a
     freshly random id (`board:<provider>:<issue>:<16 hex>`), so the arm is
     practically unreachable (2^-64); the pre-helper catch would have let it
     reach the 500, so the helper is a strict improvement, not a behavior
     change.
   - `/snapshot` (`:667`), `/schedule/list` (`:437`), `/bash` (`:835`) — call
     `resolveApplication` only, never `begin`, so `DuplicateRunError` cannot
     arise.
   The correction is recorded as an append-only dated note in
   `residual-harvest-6.md` (the fragment's own write-once rule); no code or pin
   changed. The reachable mappings stay pinned by harvest-5
   (`test/hub-runs.test.ts` 409 duplicate; `test/e2e-hub-bash.test.ts`).

2. **The affinity-pin P3 — "commit to be linked" where the tip is `c6768cd7` —
   CORRECTED (docs-only; dated note appended to `affinity-pin.md`).** The
   fragment's line 12 read "commit to be linked"; the pushed tip is
   `c6768cd7` (P19 affinity-pin narrowing, PR #409). The correction is an
   appended dated note naming the commit rather than a rewrite of the
   write-once body. No code or test change.

3. **The two-journal cross-lane eviction (item from
   `P4-sink-view.md:112-125` + `residual-harvest-5/-6`) — RE-ASSESSED,
   RECORDED (not small-safe); the follow-up is refined for the second
   journal.** Option A1 added a SEPARATE, independently FIFO-64
   `surfaceUsage` journal beside the canonical `taskUsage` journal
   (`src/integrations/run-registry.ts`). Separation removes one axis (surface
   bursts no longer evict canonical task entries) but the recorded residual
   stands: each journal still cross-evicts its own contributors, per-lane
   partitioning of the canonical journal needs a writer-signature change
   (`recordTaskUsage(input)` carries no lane key) plus a preserved flat
   projection, and a larger bound would falsify the "bounded at 64 like the
   sibling gate maps" pin. Not fixed here. The refined follow-up (recorded as a
   dated note in `P4-sink-view.md`): partition BOTH journals at the registry
   level without changing the `/snapshot`→`/api/runs` projection — canonical by
   a writer-declared lane, surface by the existing `recordedBy` stamp — with a
   cross-contributor non-eviction pin.

4. **The daemon-hold / `createOperatorAskHold` unification
   (`residual-harvest-3.md` item 1, re-checked in `-4`) — RE-ASSESSED,
   RECORDED (still not small-safe; dated note appended to
   `residual-harvest-3.md`).** The P6 hub same-process answer route
   (`docs/ledger/P6-hub-answer.md`) landed `broker.askHold()` and mounted
   `POST /api/permission`, but it explicitly leaves the OpenCode daemon lane
   OUT of process (option B), and `opencode-server-authority.ts`'s
   `holdForOperator` is unchanged and broker-free (`grep -rn "askHold" src/`
   never reaches that module). The id-domain difference and the interleaved
   fail-closed broker lifecycle remain; no red-first discriminator exists for a
   behavior-neutral refactor on a security-sensitive authority. The parallel
   standalone-seat branch (`feat/p6-standalone-answer`) has no committed
   divergence from `origin/main` at assessment time (empty diff; its tip is
   `77702361` = `origin/main`). Not fixed; concrete follow-up unchanged.

5. **Other concrete recorded P3 — the stale `/schedule/run-now` token-class
   comment in `src/integrations/workflow-hub.ts` — FIXED (source comment).**
   The harvest-6 review (`guard_review_followups`, commit `d034f578`) recorded
   that `workflow-hub.ts:94` still called
   `/schedule/list|save|delete|run-now` "operator-token" routes, contradicted
   by `hub-http.ts:233-237` (the `verifierOnly` set includes
   `/schedule/run-now`) and by the `docs/HUB_PROTOCOL.md` §3 line harvest-6
   added. The doc comment now separates the operator-token
   `/schedule/list|save|delete` routes from the verifier-only
   `/schedule/run-now`. Comment-only; no behavior or pin change.

**Evidence:**

- No red-first: items 1-4 are documentation corrections and item 5 is a source
  comment. No test, type, or runtime behavior changed.
- GREEN, focused suites (all exit 0, captured unpiped):
  - `node --import tsx --test test/hub-runs.test.ts test/hub-protocol.test.ts
    test/affinity-pin.test.ts test/surface-usage.test.ts` → `# tests 50 /
    # pass 50 / # fail 0`.
  - Broad focused battery adding `test/opencode-server-authority.test.ts`,
    `test/schedule-manager.test.ts`, `test/board-delegate.test.ts`,
    `test/hub-workspace.test.ts`, `test/hub-snapshot.test.ts` → `# tests 110 /
    # pass 110 / # fail 0 / # skipped 0`.
- `npm run lint` exit 0 (unpiped); `npm run typecheck` exit 0 (unpiped).

**Recorded, NOT fixed (honestly):**

- **Item 3:** the two-journal cross-lane eviction stays a named residual;
  partitioning either journal is a registry/write-seam change and a larger
  bound is a non-fix (the dated note in `P4-sink-view.md` carries the refined
  follow-up and the two-journal observation).
- **Item 4:** the daemon-hold/primitive unification stays not-small-safe; the
  P6 answer route serves the other seats and deliberately leaves the daemon
  lane out of process (dated note in `residual-harvest-3.md`).
- **The p4-reviewer-bind P3** (`guard_review_followups`, commit `77e5d97a`) —
  its stored summary says "one P3 (below)" but carries no P3 body; not
  resolvable from the record, named honestly rather than invented (carried
  from `residual-harvest-6.md` item 3).
- **W162's DOM-level rendered-deny round-trip P3**
  (`W162-delegate-from-a-board-card-…md:29`) — gated on the browser-e2e
  dependency decision (a human gate), unchanged.
- **The containment seat's no-operator ask provenance** and the **provider-lane
  probe dual auth header** — previously recorded watch-items, unchanged
  (`residual-harvest-5.md` item 3; `residual-harvest-3.md` item 3).

**Deviations:** none. The write-once bodies of `residual-harvest-6.md` and
`affinity-pin.md` were left as authored; both corrections ride appended dated
notes (the fragments' stated convention). No operator direction was needed
beyond the dispatch; no push/PR.
