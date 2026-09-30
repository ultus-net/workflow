<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-4 subtask, working the wave's remaining recorded review P3 nits. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 4 — the wave's remaining recorded review P3 nits (2026-09-30)

**Source:** the recorded five-axis-review P3 items from the 2026-09-30 wave's
ledger fragments and `guard_review_followups`. This subtask works the brief's
list: fix what is small + verifiable (red-first where behavior/pins change),
record the rest. Branch `feat/harvest-4` off `origin/main`. Each item names its
source below.

**What landed (per item):**

1. **The P9-D orphaned-`tool_result` false-reject watch item — ASSESSED, PINNED
   (no relaxation; safe by construction).** The detector's
   `unattributed-tool-result` signal
   (`src/integrations/messages-replay-integrity.ts:141-150`) fires only when no
   PRECEDING `tool_use` carries the result's id. Assessment against the W070b
   record and the messages-lane body shapes:
   - The anthropic Messages schema pairs a user `tool_result` with the
     assistant turn's `tool_use`; a body the vendor would accept cannot carry a
     bare result, so the signal is not a false-reject surface for a
     schema-valid host body.
   - W070b's sanctioned synthetic-tool-call insertion — the traffic the lane
     exists to carry (`src/integrations/model-replay-policy.ts:70-75`; the
     `route-anthropic` decision) — is a MATCHED `tool_use`/`tool_result` pair,
     and the host-inserted synthetic tail pinned in
     `test/model-profile.test.ts:320-328` is likewise matched. The
     sanctioned-pair allow pin
     (`test/messages-replay-integrity.test.ts:40-45`) is NOT weakened.
   - The one host shape that could produce a bare result is a replay that
     DROPPED the assistant `tool_use` (history compaction/summarization) while
     keeping the result — the exact malformed replay the tier exists to refuse,
     and the vendor rejects it too. A relaxation is therefore NOT earned.
   - Disposition: a discriminating pin now fixes the boundary (dropping the
     call from the sanctioned shape yields exactly one
     `unattributed-tool-result`, never an allow; restoring the call allows the
     same body), and the module docblock carries the safe-by-construction
     statement. The LIVE host-body audit remains the production gate before the
     tier turns on (P9-D ships DARK; the brief's `:289-292` gate).

2. **The daemon/primitive ask-hold unification
   (`docs/ledger/residual-harvest-3.md` item 1) — RE-ASSESSED, still
   not-small-safe (dated note appended there).** Checked against the parallel
   `feat/ask-answer-surface` path (the broker-unified ask-answer worktree): at
   assessment time its branch ref equals `origin/main` (no committed
   divergence), so the recorded assessment stands unchanged. The concrete
   follow-up (a wire-id-keyed variant of `createOperatorAskHold`, keeping the
   four daemon-hold pins + the real-guard e2e pin green) is unchanged; if the
   parallel broker unification lands, the daemon hold should consume the unified
   primitive rather than a second unification. No code change.

3. **The shared 64-slot journal's cross-lane eviction pressure (P4 review P3) —
   NAMED (dated note appended to `docs/ledger/P4-sink-view.md`).** The
   per-task attribution journal (`recordTaskUsage`/`taskUsage()`,
   `src/integrations/run-registry.ts:273-283`) is a single FIFO-at-64 append
   journal SHARED across lanes; the W111 record's non-collapse rule (the rollup
   is the sum of entries, so entries are never collapsed latest-per-task) means
   a burst of turns on one lane can evict another lane's still-un-summed
   entries. Recorded as a named boundary, not fixed (the fix needs a
   per-lane/per-run partitioning or a larger bound, and both change the
   projection contract).

4. **`/run/begin`'s empty/whitespace runId/title 500 (the W146 residual, W142
   finding (e)) — FIXED (red-first).** The route validated only
   `typeof … === "string"`, so an empty/whitespace `runId` or `title` rode the
   registry's `TypeError` into the catch-all 500. The route now validates
   trimmed non-emptiness before the registry is reached and answers the named
   client-fault 400 `{ error: "invalid run begin request" }`
   (`src/integrations/hub-http.ts:241-252`). The duplicate-runId 500 remains
   recorded: it fires inside the registry and needs a typed registry error or a
   membership lookup (a registry-signature change, not route-only).

**Evidence:**

- RED (item 4, pre-fix source, the new `test/hub-runs.test.ts` pin), captured
  verbatim:
  ```
  not ok 2 - a run begin with an empty runId or title is a client fault (400), not a server 500
    error: |-
      an empty runId is a client fault (W146 residual closed 2026-09-30)

      500 !== 400
    code: 'ERR_ASSERTION'
    expected: 400
    actual: 500
    operator: 'strictEqual'
  # tests 26 / # pass 25 / # fail 1
  ```
- GREEN, focused suites (all exit 0):
  - `test/hub-runs.test.ts` **26/26** (the new 400 pin, both empty-runId and
    empty-title, plus the no-composition assertion).
  - `test/messages-replay-integrity.test.ts` **9/9** (the new
    safe-by-construction pin included; the sanctioned-pair allow pin untouched).
  - `test/model-usage-proxy.test.ts` + `test/open-model-proxy.test.ts`
    (the P9-D consumers) **78/78** combined with the two above.
  - `test/e2e-hub-bash.test.ts` **2/2** (the compiled-hub battery; the flipped
    empty-runId pin now asserts 400 + the named body, the duplicate pin still
    asserts its recorded 500).
  - `test/board-delegate.test.ts` + `test/e2e-hub-routes.test.ts` **11/11**
    (the /run/begin client-origin and route-contract neighbors).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Recorded, NOT fixed (honestly):**

- **Item 1:** no relaxation — safe by construction (assessment above); the LIVE
  host-body audit remains the P9-D production gate. The sanctioned-pair allow
  pin is unchanged.
- **Item 2:** the daemon/primitive hold unification stays not-small-safe; the
  dated note in `residual-harvest-3.md` records the parallel-branch check.
- **Item 3:** the shared 64-slot journal's cross-lane eviction pressure is
  named; the partitioning/larger-bound fix is out of a harvest pass.
- **Item 4, remainder:** the duplicate-runId 500 persists (needs a typed
  registry error or a membership lookup).
- **Also found in the ledgers (named, not fixed):**
  - W175 relay review P3 (`guard_review_followups`, commit `e8777dd3`): a hub
    that predates W175 answers reason `"hub unavailable"` rather than a
    W175-specific named absence — recorded as consistent with the existing
    `hubEvidence` compromise; no ledger row, no fix.
  - W151 review P3 (commit `974e11b1`): `/schedule/delete`'s response shape
    differs from `/schedule/list`'s — "pinned as observed, owes a
    route-contract doc line"; not in a ledger fragment, left as recorded.
  - W146 residual (c): the workspace-declaration `try/catch` rethrow shape is
    duplicated at two call sites — extract a helper only if a third route
    adopts it; no action.
