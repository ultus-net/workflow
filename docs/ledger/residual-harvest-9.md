<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-9 subtask, working the wave's remaining recorded nits. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 9 — the wave's remaining recorded nits (2026-09-30)

**Source:** the orchestrator's five-item list for the wave's remaining recorded
nits (the P18 wrapper over-block watch; the A2 follow-ons; the p6 answer-route
"404 before auth" P3; the W162 DOM-level pin; any other concrete recorded P3).
This subtask fixes what is small + testable (red-first where behavior/pins
change) and records the rest. Branch `feat/harvest-9` off `origin/main`
(`a06139d2`). No push/PR.

**What landed (per item):**

1. **The P18 "over-block watch" — ASSESSED: the over-block does NOT exist; a
   discriminating pin records the boundary (test-only).** The watch feared a
   bare suffix predicate (`/sh$/i`) treating any non-shell name ending in `sh`
   (publish, flush, push, bush, hush) as an interpreter, so a would-deny inner
   command (`-c 'git commit -m x'` on `main`, `-c top`) would deny/ask through
   the wrapper lens.
   - **The landed predicate is already anchored to the family** in all three
     lanes: `mcp-toolbox/apps/workflow-guard-mcp/src/shell-policy.ts:166`,
     `src/git-policy.ts:784`, and `src/boundary-policy.ts:184,282` each use
     `/^(?:ba|z|da|k|x)?sh$/i`, never a bare `/sh$/i`. Probed live through
     `checkPolicy`: `publish`/`flush`/`push`/`bush`/`hush` with both a
     would-deny inner git command and an interactive inner command return
     `allow`; the genuine family (`sh`/`bash`/`xsh`/`dash`/`ksh`/`zsh`) still
     denies/asks. There is nothing to narrow that would not reopen the W102
     wrapper bypass.
   - **New pin** `test/policy.test.ts` "P18 (over-block watch): non-shell names
     ending in sh are not sh-family wrappers" asserts the boundary in both the
     git lane (`-c 'git commit -m x'` on `main`) and the interactive lane
     (`-c top`), plus the family contrast arm (`sh -c 'git commit …'` deny,
     `xsh -c top` ask).
   - **Discrimination (red, mutation proof):** the pin is green as-found, so
     there is no red-first by construction. To prove it discriminates the
     precise over-block, BOTH lanes' predicates were temporarily widened to
     `/sh$/i` and the suite captured red (verbatim below); the mutation was
     reverted (`git diff --stat -- …/src/` empty) and green restored. Honest:
     a mutation proof, not a red-first pin change.

2. **A2 follow-ons — the webapp canonical rendering CONFIRMED; the
   `recordedBy`-drop and the TTL/FIFO-64 session-map parameters RECORDED as
   watch items.**
   - **(a) The webapp renders the canonical interactive attribution —
     CONFIRMED (no re-pin needed).** `src/ui/webapp/run-detail-panel.tsx`'s Cost
     tab renders the recorded canonical `run:<id>` `taskUsage` entries verbatim
     plus the recorded rollup (SUM of records), joined on the exact recorded
     task id and deriving nothing view-side. The pin
     `test/webapp-runs.test.ts` "W111 (issue #283): the per-task view renders
     the RECORDED deltas verbatim, the rollup a sum of records, and names
     absent/empty" (file 22/22 here) already asserts this. Option A2's
     interactive surfaces write that SAME canonical `taskUsage` journal, so once
     the A2 branch lands they render with no view change. The claim holds.
   - **(b) Watch items recorded (the queued A2 implementation on
     `feat/topo-a2`, commit `c6d00d85`, is NOT on this trunk; its own record
     `docs/ledger/topo-a2.md` states the parameters but does not flag the paths
     as untested):**
     - **`recordedBy`-drop.** A2 writes the CANONICAL `taskUsage`, whose
       `TaskUsageSummary` carries no provenance field, so the surface label is
       dropped from the A2 record (the four surfaces' `surface:<name>` /
       `surface:web-service:<sessionId>` stamps are no longer sent); session
       identity lives only in the hub's consumed session map. Watch item: the
       provenance legibility the A1 surface journal provided is gone on the A2
       path — the canonical journal is attribution-authoritative but
       provenance-blind. Per-surface provenance on the canonical path would need
       a canonical shape change, out of scope per the A2 record's
       "pre-existing writers unchanged".
     - **TTL / FIFO-64 session-map.** `registerSurfaceSession` holds a hub-owned
       bounded (FIFO 64) map with a 5-minute TTL, single-use (consumed before
       the write). Watch item: the A2 review's P3 records that **the 5-minute
       TTL expiry and the FIFO-64 session eviction paths are untested**, and the
       branch also carries a dead-export P3 (`SurfaceUsageSessionRecord`,
       `src/integrations/task-usage.ts`). These cannot be fixed on this trunk
       (the code is not present); recorded here so the A2 landing owes their
       pins.

3. **The p6 answer-route "404 before auth" P3 — decision VERIFIED and made
   durable (docs-only).** The review of `feat/p6-standalone-answer` recorded one
   non-material P3: `handlePermissionRequest`
   (`src/ui/permission-broker-route.ts`) matches method/path before the
   bearer-token check, so an unauthenticated loopback client can distinguish
   route existence by 404 vs 401. The decision was made on `feat/harvest-8`
   (commit `bf62642c`, "decided no-pin") but that branch is not on this trunk,
   so a dated disposition note is appended to
   `docs/ledger/P6-standalone-answer.md`: **no pin, no reorder** — the posture
   is deliberate and mirrors the hub bridge's dispatcher, the server is
   loopback-only on an ephemeral port behind a 32-byte random token, a pin
   would freeze a cosmetic information leak as intended behavior, and the
   substantive directions are already pinned (`test/p6-standalone-answer.test.ts`
   pin 4: no token → 401; wrong path with a valid token → 404). The decision is
   now durable on the post-#412 trunk.

4. **The W162 DOM-level rendered-deny round-trip pin — CONFIRMED still named
   (not dropped).** It remains a registered deferral, named in
   `docs/ledger/W162-delegate-from-a-board-card-the-amendments-first-dispatch-class-addition.md:29`
   (the delegate refusal verified end-to-end in the browser e2e tier is "gated
   on the browser-e2e dependency decision … a human gate"), re-affirmed in
   `docs/ledger/CLOSURE-SWEEP-2026-09-30.md` ("the DOM-level reason-propagation
   pin's browser-e2e human gate") and
   `docs/ledger/CLOSURE-CONFIRMATIONS-2026-09-30.md` ("the DOM-level pin's
   browser-e2e human gate"), and carried in `docs/ledger/residual-harvest-7.md`
   item "W162's DOM-level rendered-deny round-trip P3". No edit; it is a human
   gate, not a silently dropped pin.

5. **Other concrete recorded-not-fixed P3 in `docs/ledger/` — swept; all
   already recorded/dispositioned.** The ledger's "Recorded, NOT fixed" lists
   (harvest-2…7) name: the two-journal cross-lane eviction (not small-safe; the
   exact falsifier `test/hub-runs.test.ts:592` recorded on `feat/harvest-8`);
   the containment seat's no-operator ask provenance (byte-identical e2e wire
   pin governs); the daemon-hold `createOperatorAskHold` unification
   (not-small-safe); the P9-D orphaned-`tool_result` watch (safe by
   construction); the messages-lane journal not surfaced (queued boundary); the
   W175 relay "hub unavailable" reason (consistent with the `hubEvidence`
   compromise); the provider-lane probe dual auth header (operator-gated watch);
   the p4-reviewer-bind P3 (recorded without a body, named honestly); and the
   W162 DOM-level pin (human gate, item 4 above). The W151 `/schedule/delete`
   route-contract line and the affinity-pin "commit to be linked" were fixed in
   harvest-6/7. No new concrete recorded-not-fixed P3 remains that this pass can
   fix small + safe.

**Evidence:**

- **RED (mutation proof, item 1 — the pin discriminates the over-block):** both
  lanes' predicates temporarily widened to `/sh$/i`; captured verbatim:
  ```
  not ok 86 - P18 (over-block watch): non-shell names ending in sh are not sh-family wrappers
    error: |-
      publish commit

      'deny' !== 'allow'

  # tests 125
  # pass 124
  # fail 1
  ```
  The mutation was reverted (`git diff --stat -- mcp-toolbox/apps/workflow-guard-mcp/src/`
  empty) and green restored.
- **GREEN, focused suites (exit 0, captured unpiped):**
  - guard `test/policy.test.ts` — **125/125 pass, 0 fail** (124 pre-existing +
    the 1 new pin).
  - `test/webapp-runs.test.ts` — **22/22 pass, 0 fail** (the canonical per-task
    rendering pin for item 2(a)).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Recorded, NOT fixed (honestly):**

- **Item 1:** no predicate change — the over-block does not exist; the new pin
  is the safeguard against a future widening to `/sh$/`.
- **Item 2(b):** the A2 session-map TTL/FIFO-64 expiry paths and the dead
  `SurfaceUsageSessionRecord` export are queued with `feat/topo-a2` (code not on
  this trunk); recorded as watch items so the A2 landing owes their pins.
- **Item 5:** the named residuals stand (already recorded; not small-safe or
  human-gated).

**Deviations:** the `feat/harvest-8` and `feat/topo-a2` branches are not
ancestors of this branch's base; items 2(b), 3, and 5 re-verify or re-record
decisions made on those unmerged branches, so the durable copy lands here. No
`npm test` (focused suites only, per the operator resource directive). No
operator direction needed beyond the dispatch; no push/PR.
