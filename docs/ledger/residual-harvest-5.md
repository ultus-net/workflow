<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-5 subtask, working the wave's remaining recorded nits. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 5 — the wave's remaining recorded nits (2026-09-30)

**Source:** the recorded five-axis-review items from the 2026-09-30 wave's
ledger fragments. This subtask works the brief's list: fix what is small +
verifiable (red-first where behavior/pins change), record the rest. Branch
`feat/harvest-5` off `origin/main` (base `ec044d91`). Each item names its
source below.

**What landed (per item):**

1. **`/schedule/list`'s unguarded `resolveApplication` (the residual-harvest-3
   `lineageSnapshot` candidate) — FIXED (red-first).** The lineage snapshot
   reached the SAME `canonicalWorkspace` refusal as `/snapshot`, `/bash`, and
   `/run/begin` but did not classify it, so a non-canonical workspace
   declaration rode the catch-all's 500
   (`src/integrations/hub-http.ts`, the `/schedule/list` route). The route now
   catches `WorkspaceDeclarationError` → 400 with its message, mirroring the
   W146 pattern; every other resolver fault still rethrows to the 500. The
   guard is byte-consistent with `/snapshot`'s (`residual-harvest-3.md` item 4).

2. **`/run/begin`'s duplicate-runId 500 (the W142 finding (e) /
   residual-harvest-4 remainder) — FIXED (red-first).** `run-registry.ts`'s
   `begin` now throws a typed `DuplicateRunError extends TypeError`
   (`src/integrations/run-registry.ts`); `/run/begin` catches it and answers
   **409** `{ error: "duplicate run: <id>" }` — a client conflict, not the
   catch-all's 500. Subclassing `TypeError` keeps every existing
   `instanceof TypeError` posture working (the `WorkspaceDeclarationError`
   pattern). Only an ACTIVE run can conflict (finished runs are removed from
   the map), so the class can only fire on a live duplicate.

3. **The containment seat's no-operator ask provenance — ASSESSED, RECORDED
   (no change; the e2e pin governs).** When no `hold` is attached, an `ask`
   collapses into the existing `decision !== "allow"` branch and throws the
   byte-identical `guard denied process execution: '<policy>': <reason>`
   (`src/containment/workflow-process.ts:70-71`). A distinct no-operator
   message would break the pin that governs:
   - `test/e2e-hub-bash.test.ts:366` asserts the exact wire body
     `{ error: "guard denied process execution: promotion-gate: …" }`
     (`deepEqual`), and `test/guarded-process.test.ts:139` is the matching
     regression fence.
   - The wire carries only `error.message`, so provenance that lives on the
     error class/`cause` (which would not change the string) cannot surface to
     a client — it would be unobservable provenance, not a fix.
   - `docs/ledger/P6-containment-seat.md:45` already records this as the
     deliberate "No distinct no-operator ask provenance" limit (the approved
     path's reject/timeout message IS distinct:
     `guard ask '…' denied (operator reject or hold timeout, failing closed)`).
   Disposition: recorded, no change. The distinct provenance exists on the
   answered path; the unanswerable path stays byte-identical by design.

4. **The shared 64-slot task-usage journal's cross-lane eviction (named in
   `docs/ledger/P4-sink-view.md`) — ASSESSED, RECORDED (not small-safe).** The
   per-task journal (`recordTaskUsage`/`taskUsage()`,
   `src/integrations/run-registry.ts`) is one FIFO-64 append array shared
   across every lane that supplies a driver sink (scheduler, RSI, reviewer), so
   a burst on one lane can evict another lane's still-un-summed entries.
   - **Partitioning (per-lane bounds): not small-safe.** The journal is a flat
     `TaskUsageSummary[]` and `recordTaskUsage(input)` carries no lane key. A
     per-lane partition needs the writer to declare its lane — a signature
     change across at least three call sites (`src/cli/hub.ts`'s scheduler
     `runTurn` finally, the RSI `laneTaskUsageSink`, the reviewer factory) —
     plus a preserved flat projection. That is a registry/API change for its
     own iteration, not a harvest pass.
   - **A larger bound: a mitigation, not a fix.** Raising the constant only
     delays cross-lane eviction, and it would falsify the shared
     "bounded at 64 like the other gate maps" discipline pinned at
     `test/hub-runs.test.ts:567,571` and held by all eight sibling gate maps.
   Disposition: named residual; the concrete follow-up is a registry-level
   per-lane (or per-task) partition that keeps the flat `/snapshot`→`/api/runs`
   projection unchanged. The parallel-branch note in `P4-sink-view.md` stands.

**Evidence:**

- RED (item 1, pre-fix `src/integrations/hub-http.ts`, the new
  `test/schedule-manager.test.ts` pin), captured verbatim:
  ```
  not ok 38 - schedule/list classifies a non-canonical workspace declaration as a client fault (400)
    error: |-
      a relative workspace declaration is a client fault (400), not a server fault
      
      500 !== 400
    code: 'ERR_ASSERTION'
    expected: 400
    actual: 500
    operator: 'strictEqual'
  ```
- RED (item 2, pre-fix source, the new `test/hub-runs.test.ts` pin),
  captured verbatim:
  ```
  not ok 3 - a duplicate run begin is a client conflict (409), not a server 500
    error: |-
      a duplicate runId is a client conflict (409), not a server fault
      
      500 !== 409
    code: 'ERR_ASSERTION'
    expected: 409
    actual: 500
    operator: 'strictEqual'
  ```
- GREEN, focused suites (all exit 0):
  - `test/hub-runs.test.ts` + `test/schedule-manager.test.ts` **38/38** (both
    new pins included; the schedule pin asserts the named 400 for the relative
    AND the non-existent workspace).
  - In-process battery `test/hub-runs.test.ts` + `test/hub-protocol.test.ts` +
    `test/hub-scheduler.test.ts` + `test/schedule-manager.test.ts` +
    `test/board-delegate.test.ts` + `test/hub-workspace.test.ts` **70/70**.
  - `test/e2e-hub-bash.test.ts` **2/2** (the compiled hub battery; the flipped
    duplicate pin now asserts 409 + the named body).
  - `test/e2e-hub-routes.test.ts` **1/1** (the compiled route battery).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Recorded, NOT fixed (honestly):**

- **Item 3:** the containment seat's no-operator ask keeps the byte-identical
  guard-deny message; the e2e wire pin governs and a message change is not
  earned (assessment above). `docs/ledger/P6-containment-seat.md:45` records
  the same limit.
- **Item 4:** the shared 64-slot journal's cross-lane eviction is named;
  per-lane partitioning is a write-seam signature change and a larger bound is
  a non-fix, so neither lands here.
- **W151 review P3** (`guard_review_followups`, commit `974e11b1`):
  `/schedule/delete`'s response shape differs from `/schedule/list`'s — still
  "pinned as observed, owes a route-contract doc line"; not in a ledger
  fragment, left as recorded (carried from `residual-harvest-4.md`).
- **W146 residual (c):** the workspace-declaration `try/catch` rethrow shape is
  now duplicated at THREE call sites (`/run/begin`, `/snapshot`, `/schedule/list`)
  — the harvest-4 note said "extract a helper only if a third route adopts it";
  a third route has now adopted it, so the extraction is now earned as a small
  follow-up. Named here; not folded into this pass (the three sites are
  byte-consistent and independently pinned).
