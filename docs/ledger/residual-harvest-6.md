<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-6 subtask, working the wave's remaining recorded nits. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 6 — the wave's remaining recorded nits (2026-09-30)

**Source:** the recorded five-axis-review items from the 2026-09-30 wave's
ledger fragments and `guard_review_followups`. This subtask works the brief's
list: fix what is small + testable (red-first where behavior/pins change),
record the rest. Branch `feat/harvest-6` off `origin/main`. Each item names its
source below.

**What landed (per item):**

1. **The earned W146 rethrow extraction — FIXED (behavior-neutral refactor).**
   The client-fault classification catch
   (`WorkspaceDeclarationError` → 400, typed `DuplicateRunError` → 409) was
   duplicated across the routes that resolve a client-declared workspace. The
   harvest-4 note's condition ("extract a helper only if a third route adopts
   it") is met, so the shared helper now exists:
   `sendClientFault(response, error)` (`src/integrations/hub-http.ts`), which
   single-sources the mapping, writes the client-fault response, and returns
   true so the caller returns; any other error returns false and the caller
   rethrows to the catch-all's 500.
   - Used at every site that carried the shape. The ledger/harvest-5 note said
     "THREE call sites (/run/begin, /snapshot, /schedule/list)"; reality has
     **five** `WorkspaceDeclarationError` sites — the three above plus
     `/board/delegate` and `/bash` — all five now consume the helper (and
     `/run/begin`'s `DuplicateRunError` → 409 rides the same helper). The count
     is corrected here; `/board/delegate` and `/bash` were not a different
     shape, just uncounted.
   - Behavior is byte-identical: same statuses, same `{ error: <message> }`
     bodies, same rethrow of every other fault. No test was changed. The
     existing behavioral pins are the discriminator (see the mutation proof in
     Evidence).

2. **The `/schedule/delete` route-contract doc line (the W151 review P3,
   carried in `residual-harvest-4.md`/`-5.md`) — FIXED (docs-only, small-safe).**
   The P3 recorded that `/schedule/delete`'s response shape differs from
   `/schedule/list`'s and owed "a route-contract doc line".
   `docs/HUB_PROTOCOL.md` §3's Workflow-internal-endpoints region now documents
   the hub-manager schedule routes and names the asymmetry: `/schedule/list`
   enriches each entry with the W153 `lineage` block and adds `recentRuns`,
   while `/schedule/save` and `/schedule/delete` echo the raw persisted table
   as `{ "schedules": [<definition>] }`; `/schedule/run-now` is verifier-only.
   The observed shapes are the ones already pinned in
   `test/e2e-hub-routes.test.ts`.

3. **The latest review records' concrete P3 — addressed via item 2.**
   The most recent record (`p4-reviewer-bind`, commit `77e5d97a`) states "one
   P3 (below)" but its stored summary carries no P3 body — not resolvable from
   the record, named honestly rather than invented. The nearest concrete,
   still-open P3 in the records is the W151 `/schedule/delete` shape line,
   fixed under item 2. No other open record names a small-safe code fix.

**Recorded, NOT fixed (honestly):**

- **Shared 64-slot task-usage journal's cross-lane eviction**
  (`docs/ledger/P4-sink-view.md:112-125`; P4 review P3, commit `4d1b5970`) —
  unchanged. A fix needs per-lane/per-run partitioning (a `recordTaskUsage`
  writer-signature change across the scheduler/RSI/reviewer call sites plus a
  flat projection) or a larger bound (a mitigation that falsifies the shared
  "bounded at 64 like the other gate maps" discipline pinned in
  `test/hub-runs.test.ts`). Not small-safe; the harvest-5 assessment stands.
- **Containment seat's no-operator ask provenance**
  (`docs/ledger/P6-containment-seat.md:45`) — recorded, no change. A distinct
  no-operator message would break the byte-identical e2e wire pin
  (`test/e2e-hub-bash.test.ts`'s promotion-gate body) and provenance on the
  error class/`cause` would not surface through the wire's `error.message`; the
  limit is deliberate and already recorded.
- **Daemon-hold / `createOperatorAskHold` unification**
  (`residual-harvest-3.md` item 1, re-assessed in `-4.md`) — remains
  not-small-safe (wire-id domains differ; interleaved fail-closed broker;
  no red-first discriminator for a behavior-neutral refactor).
- **P9-D orphaned-`tool_result` watch item** (`residual-harvest-4.md` item 1) —
  safe by construction; the LIVE host-body audit remains the production gate.
- **Messages-lane journal not surfaced** (`residual-harvest-2.md` item 4) —
  queued boundary, anti-drift pin holds; no consumer wired.
- **W175 relay "hub unavailable" reason for a pre-W175 hub**
  (`residual-harvest-4.md`) — consistent with the existing `hubEvidence`
  compromise; unchanged.
- **Provider-lane probe dual auth header** (`residual-harvest-3.md` item 3) —
  recorded watch-item; unchanged.

**Evidence:**

- RED (item 1, mutation proof — the shared helper is load-bearing): the helper
  was temporarily short-circuited to `return false` (every client fault then
  rethrows to the 500), focused in-process battery 52 tests / 48 pass / 4 fail,
  captured verbatim (failing titles):
  ```
  not ok 5 - W162: the delegate route's refusals render verbatim — capability withheld, invalid bodies, workspace faults, and provider states
  not ok 13 - a duplicate run begin is a client conflict (409), not a server 500
  not ok 38 - hub fails closed on an invalid workspace declaration
  not ok 52 - schedule/list classifies a non-canonical workspace declaration as a client fault (400)
  # tests 52
  # pass 48
  # fail 4
  ```
  The mutation was reverted (verified: no `HARVEST6_MUTATE` remains); no test
  was changed, so this is a mutation proof, not a red-first pin change.
- GREEN, focused suites (all exit 0):
  - In-process battery `test/hub-runs.test.ts` + `test/schedule-manager.test.ts`
    + `test/board-delegate.test.ts` + `test/hub-workspace.test.ts` +
    `test/hub-protocol.test.ts` + `test/hub-snapshot.test.ts` **60/60** (the
    five helper sites and both refusal classes are covered: 409 duplicate,
    400 workspace faults on the delegate route, `/snapshot`, and
    `/schedule/list`).
  - `test/e2e-hub-bash.test.ts` **2/2** (the compiled-hub battery: the 409
    duplicate pin, the 400 empty-runId and non-canonical-workspace pins).
  - `test/e2e-hub-routes.test.ts` **1/1** (the compiled route battery,
    including the `/schedule/delete` shape now documented).
  - `test/e2e-hub-schedule.test.ts` **2/2** (the spawned-hub schedule battery).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped, after the
  mutation was reverted).

> **Dated note (2026-09-30, branch `feat/harvest-6`):** the duplicated
> try/catch-rethrow shape recorded as the third W146 residual
> (`docs/ledger/W146-…md:52-54`, and the harvest-4 dated note at `:67-68`) is
> now closed by the `sendClientFault` extraction (item 1); the duplicate-runId
> 500 it also names was already closed in harvest-5 (typed `DuplicateRunError`
> → 409). The W151 `/schedule/delete` route-contract doc line is closed by
> item 2.

> **Dated correction (2026-09-30, branch `feat/harvest-7`):** item 1's
> "Behavior is byte-identical" wording is corrected here as marginally
> overstated. It is accurate for the reachable behavior (the
> `WorkspaceDeclarationError` → 400 arm at all five sites, and the
> `DuplicateRunError` → 409 arm at `/run/begin`), but the `DuplicateRunError`
> arm is NOT exercised at the other four sites: `/snapshot`, `/schedule/list`,
> and `/bash` call `resolveApplication` only (no `runController.begin`, so the
> class cannot arise), and `/board/delegate` begins a run under a freshly
> random id (`board:<provider>:<issue>:<16 hex>`, `hub-http.ts`), so the arm is
> practically unreachable there (2^-64) and the old catch would have let it
> reach the 500. The harvest-6 review recorded this exactly (commit
> `d034f578`, `guard_review_followups` P3): a strict correctness improvement on
> an unreachable path, not a behavior change at those sites. No code or pin
> changed; the reachable mappings are the ones harvest-5 pinned
> (`test/hub-runs.test.ts` 409 duplicate; `test/e2e-hub-bash.test.ts`). See
> `residual-harvest-7.md` item 1.
