<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-8 subtask, working the wave's remaining recorded nits. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 8 — the wave's remaining recorded nits (2026-09-30)

**Source:** the recorded five-axis-review items from the 2026-09-30 wave's
ledger fragments and `guard_review_followups`, dispatched as "the remaining
recorded nits" (the batch-14 P3s; the two-journal partitioning; the stale
compiled-e2e `/bash` pin; any other concrete recorded P3). This subtask fixes
what is small + testable (red-first where behavior/pins change) and records the
rest. Branch `feat/harvest-8` off `origin/main` (`61fe0614`, which includes the
landed `feat/p6-standalone-answer` #412 and `feat/p4-surface-view` #415). No
push/PR.

**What landed (per item):**

1. **The batch-14 P3s, three dispositions:**

   a. **The harvest-7 "no committed divergence" observation — CORRECTED
   (docs-only; dated supersession note appended to `residual-harvest-7.md`
   item 4).** That record said `feat/p6-standalone-answer` "has no committed
   divergence from `origin/main` at assessment time (empty diff; its tip is
   `77702361` = `origin/main`)". It is now superseded: the branch landed (merge
   `1605c995`, PR #412), so the standalone contained-shell seat composes a
   same-process `PermissionBroker` and serves the shared `permissionAnswerRoute`
   on a permission-only loopback server. The item-4 residual itself (the
   daemon-hold/`createOperatorAskHold` unification) is unchanged — the landing
   did not touch the OpenCode daemon lane; only the "no divergence" observation
   changed.

   b. **The p6-hub-answer route "404s before auth" P3 — DECIDED: NO pin
   (recorded disposition).** The review observed that
   `src/ui/permission-broker-route.ts:114-115` matches method/path before
   checking the bearer token, so an unauthenticated client can distinguish
   route existence by 404-vs-401. Decision: **do not pin it and do not
   reorder.** The posture is deliberate (`handlePermissionRequest` mirrors the
   hub bridge's dispatch, where route matching likewise precedes auth), it is
   loopback-only with an ephemeral port and a 32-byte random token, and it is
   non-material (the review's words: "same posture as the existing hub bridge,
   loopback-only, not material"). A pin would freeze a cosmetic information
   leak as intended behavior, and flipping the order would diverge from the
   hub bridge's contract; the existing pin already covers both substantive
   directions (`test/p6-standalone-answer.test.ts` pin 4: no token → 401,
   wrong path with a valid token → 404). Recorded, not changed.

   c. **The p4-surface-view P3 (the new `run-surface-usage` class had no CSS
   rule) — FIXED (paired CSS rules + red-first pin).** The class (and its
   pre-existing sibling `run-task-usage`) had no rule. Added ONE shared
   list-reset + mono machine-value rule for both journals
   (`src/ui/webapp/styles.css`), so the new surface section is not the unstyled
   odd one out and the two render consistently. Pin added:
   `test/webapp-runs.test.ts` "the Cost tab's task + surface usage journals
   carry a shared list style" (asserts the paired selectors carry
   `list-style: none` and `font-family: var(--font-mono)`).

2. **The two-journal partitioning — RE-ASSESSED, RECORDED (not small-safe);
   the concrete follow-up is unchanged and the exact falsifier is now named.**
   The task asked to partition the canonical `taskUsage` journal by lane and the
   `surfaceUsage` journal by `recordedBy` without changing the projection
   contract. This pass attempted it and confirmed it does not fit a small-safe
   change:
   - The canonical journal's shared TOTAL bound is pinned explicitly at
     `test/hub-runs.test.ts:592` (`registry.taskUsage().length === 64`,
     "bounded at 64 like the other gate maps"). Non-eviction across
     contributors requires each contributor to have a non-evicting share, which
     makes the flat journal's total bound `64 × #lanes` (or a new per-lane
     cap) — so that pin and the "bounded at 64 like the sibling gate maps"
     discipline (eight sibling maps) would have to be restated. That is
     contract-adjacent, not small-safe.
   - `recordTaskUsage(input)` still carries no lane key, so a canonical
     partition also needs a writer-signature change across three call sites
     (`src/cli/hub.ts`: the RSI `laneTaskUsageSink` :175, the scheduler
     `runTurn` finally :319, the reviewer factory via `RunReviewerFactory`).
   - The surface journal's `recordedBy` partition would NOT need a signature
     change, but a fix to only one of the two journals is partial (the harvest-7
     reasoning: it leaves the canonical lane unpartitioned), so it is not landed.
   Recorded as a dated re-assessment note in `P4-sink-view.md`; the flat
   `/snapshot`→`/api/runs` projection contract is untouched.

3. **The stale compiled-e2e hub `/bash` pin (`test/e2e-hub-bash.test.ts`) —
   FIXED and RUN (the dists WERE buildable here).** The dists were absent, so
   this pass built both and ran the compiled e2e, capturing the red verbatim
   (below), then updated the pin.
   - **Build:** the vendored guard dist was built by symlinking the main
     checkout's `node_modules` into `mcp-toolbox/` and invoking the guard's own
     `tsc -p tsconfig.json` directly (`GUARD TSC EXIT 0`; `dist/server.js`
     present) — a deviation from the fixture's `pnpm --dir mcp-toolbox … build`
     remedy (no `pnpm install` was needed: the guard's deps — typescript,
     @types/node, @modelcontextprotocol/sdk, zod — all resolve from the main
     tree). The main `dist` was built with `npm run build` (exit 0).
   - **Red (the OLD pin against the LANDED hold):** the promotion-gate ask no
     longer denies immediately; it parks on the hub's same-process broker and
     times out to reject at the 120s default, then denies with the operator
     provenance. Verbatim (first test 125204 ms; the suite read
     `# tests 2 / # pass 1 / # fail 1`):
     ```
     not ok 1 - the compiled hub's /bash and /run/begin lanes: auth directions, the contained-shell contract, the refusal shapes, and the run-record lifecycle
       error: |-
         observed: {"error":"guard ask 'promotion-gate' denied (operator reject or hold timeout, failing closed): Installing into the live control plane requires operator approval (T1 promotion): run it from the operator's shell."}
         + actual - expected
           {
         +   error: "guard ask 'promotion-gate' denied (operator reject or hold timeout, failing closed): Installing into the live control plane requires operator approval (T1 promotion): run it from the operator's shell."
         -   error: "guard denied process execution: promotion-gate: Installing into the live control plane requires operator approval (T1 promotion): run it from the operator's shell."
           }
       stack: TestContext.<anonymous> (.../test/e2e-hub-bash.test.ts:368:10)
     ```
   - **Updated pin:** rather than let the pin ride the 120s timeout, it now
     answers the held ask through the hub's own route — the seat's `/bash`
     request is fired, the ask is observed on `POST /api/permission`
     (`pendingAsks` `contained-process-ask-*`), it is rejected there
     (`reject_once`), and the `/bash` response is asserted to be the landed
     500 operator-reject/deny message. This exercises MORE of the landed hold
     (answerability) and runs in ~0.75s instead of 125s; the timeout path emits
     the SAME wire message (observed in the red capture). Green: 2/2.

4. **Any other concrete recorded P3 in `docs/ledger/` — the a2c-brief
   line-cite drift CORRECTED (docs-only; dated note appended to
   `P4-a2c-migration-brief.md`).** The `feat/p4-a2c-brief` review recorded three
   non-material P3s (a few file:line cites off by 1-3 lines). Verified against
   this worktree: all constructs resolve. The note records the current anchors —
   `surfaceUsageSink` now `src/integrations/task-usage.ts:233-239` (was cited
   `:215-221`; drifted by the later `feat/p4-surface-view` `surfaceStamp`
   addition), `METERED_PLACEHOLDER_KEY` at
   `src/integrations/egress-credential.ts:20`, and the W111 docs-only cite at
   `docs/ledger/W111-attribution-design-brief.md:46`. The remaining recorded
   P3s were re-checked and are already dispositioned or human-gated, so this
   pass leaves them as-is: the daemon-hold unification (residual-harvest-3/4);
   the W162 DOM-level rendered-deny pin (gated on the browser-e2e dependency
   decision, a human gate); the W151 `/schedule/delete` line (fixed harvest-6);
   the affinity-pin "commit to be linked" (fixed harvest-7); the provider-lane
   probe dual auth header and the containment seat's no-operator ask provenance
   (recorded watch-items).

**Evidence:**

- **RED captures (verbatim, both behavior/pin changes):**
  - item 1c, `test/webapp-runs.test.ts` against the unmodified `styles.css`:
    ```
    not ok 23 - the Cost tab's task + surface usage journals carry a shared list style — the surface section is not the unstyled odd one out
      error: 'the two usage journals share one list-reset rule'
    # tests 23 / # pass 22 / # fail 1
    ```
  - item 3, the compiled e2e (full block above): `# tests 2 / # pass 1 /
    # fail 1`, first test `duration_ms: 125204.016281`.
- **GREEN, focused suites (all exit 0, captured unpiped):**
  - item 3: `node --import tsx --test test/e2e-hub-bash.test.ts` →
    `# tests 2 / # pass 2 / # fail 0` (first test `duration_ms: 750.458537`).
  - item 1c + attribution surfaces: `test/webapp-runs.test.ts
    test/webapp-surface.test.ts test/task-usage.test.ts
    test/surface-usage.test.ts test/p6-standalone-answer.test.ts
    test/p6-hub-answer.test.ts test/hub-protocol.test.ts test/hub-runs.test.ts`
    → **123/123 pass, 0 fail, 0 skipped** (webapp-runs alone 23/23).
  - P6/permission battery: `test/p6-hub-ask-e2e.test.ts
    test/p6-live-seats.test.ts test/permission-broker.test.ts
    test/permission-approvability.test.ts test/permission-grants.test.ts
    test/guarded-process.test.ts` → **43/43 pass, 0 fail, 0 skipped**.
- `npm run lint` exit 0 (unpiped); `npm run typecheck` exit 0 (unpiped); both
  re-run after every edit.

**Recorded, NOT fixed (honestly):**

- **Item 2:** the two-journal partitioning stays a named residual; the exact
  blocker is the total-bound pin at `test/hub-runs.test.ts:592` plus the
  missing writer lane key (dated note in `P4-sink-view.md`).
- **Item 1b:** no pin for the route-match-before-auth posture; recorded above as
  an accepted, hub-bridge-consistent, loopback-only disposition.
- The daemon-hold/`createOperatorAskHold` unification, the W162 DOM-level pin
  (human gate), and the provider-lane/containment-seat watch-items: unchanged
  (see item 4).

**Files changed:** `src/ui/webapp/styles.css` (paired usage-journal rules),
`test/webapp-runs.test.ts` (the CSS pin), `test/e2e-hub-bash.test.ts` (the
landed-hold pin), `docs/ledger/residual-harvest-7.md`,
`docs/ledger/P4-sink-view.md`, `docs/ledger/P4-a2c-migration-brief.md` (dated
notes), and this fragment. (The built `dist/` and the `mcp-toolbox/node_modules`
symlink are gitignored; `git status --short` shows only the six tracked edits.)

**Deviations:** the guard dist was built via a symlinked `node_modules` + direct
`tsc` rather than the fixture's `pnpm` remedy (item 3) — no `pnpm install` was
required because the deps resolve from the main tree; the fixture still finds
the built dist fresh and does not rebuild. The e2e pin answers the ask on the
route instead of riding the 120s timeout (same wire message, faster and more
coverage; item 3). No operator direction was needed beyond the dispatch; no
push/PR.
