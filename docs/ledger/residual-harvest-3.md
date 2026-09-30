<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the 2026-09-30 residual-harvest-3 subtask, working the wave's remaining concrete P3 review debt. Write-once: append dated supersession notes, never rewrite. -->

### Residual harvest 3 — the wave's remaining concrete P3 review debt (2026-09-30)

**Source:** the recorded five-axis-review P3 items from the 2026-09-30 wave's
ledger fragments. This subtask works the remainder: fix what is small +
verifiable (red-first where behavior changes), record the rest. Branch
`feat/harvest-3` off `origin/main`. The task brief named four items; the
sources are named per item below. ("batch-9" did not resolve to a committed
batch label anywhere under `docs/` — `grep -rniE "batch[- ]?9"` is empty and
`guard_review_followups` carries no batch-9 tag — so item 4 was satisfied by
the clearest concrete recorded review P3 that is small + testable, named
honestly below.)

**What landed (per item):**

1. **The lockstep extraction follow-up (daemon hold vs `createOperatorAskHold`)
   — RECORDED, not fixed (assessed not-small-safe).** The two holds implement
   the same park/timeout/reconcile arithmetic, but unifying them is not a small
   *safe* change in this pass:
   - **Different id domains + reply vocabularies at the boundary.** The daemon
     hold (`src/integrations/opencode-server-authority.ts:352-373`) is keyed by
     the SSE permission-request id (`request.id`) and its reply is the wire's
     `"once" | "always" | "reject"`; the primitive
     (`src/integrations/operator-ask-hold.ts`) is keyed by whatever id its
     caller passes (the ACP resolver passes `toolCallId`,
     `src/adapters/acp-workflow-resolver.ts`) and its `answer()` accepts
     `"allow" | "deny" | OperatorAskReply`. A unification needs a narrowing
     shim plus a synthesized `park(OperatorAskRequest)` payload (policy/reason)
     the daemon does not build.
   - **Lifecycle ownership is interleaved in an async, fail-closed broker.**
     The daemon's hold is embedded in `answer()` and its result gates
     `deliver()` + `rememberAllowed()` coverage seeding
     (`opencode-server-authority.ts:336-350`); its cancellation is owned by the
     authority's `start()`/`stop()`. The primitive is an instance-owned object.
     Threading it through the broker touches the fail-closed decision path whose
     only end-to-end proof is the live-e2e spawn harness
     (`test/opencode-server-ask-e2e.test.ts`).
   - **No red-first discriminator exists for a behavior-neutral refactor**, and
     the wave's review discipline flags behavior-neutral churn on a
     security-sensitive authority in a harvest pass. The P6 fragment already
     names the unification as follow-up debt
     (`docs/ledger/P6-first-seat-ask-hold.md:44`), so this is a decision not to
     re-open it here, not a dropped item.
   - **Concrete follow-up:** extract the park/timeout/early-reply arithmetic
     into a wire-id-keyed variant of the primitive (or widen
     `OperatorAskRequest` to accept a bare id) and have
     `opencode-server-authority.ts` consume it, keeping the four daemon hold
     pins (`test/opencode-server-authority.test.ts`) and the real-guard e2e pin
     green; the resolver's `toolCallId` seat rides the same module.

2. **`docs/ledger/P13b-per-turn-marks.md` red transcript names a superseded
   test title — RECORDED (append-only dated note).** The transcript's
   `not ok 12` names `W109: the marker pass is opt-in and wire-gated —
   everything else passes through untouched`; the P13b review fix (commit
   `e741d20e`) renamed the test to `… — the dark default and the openai wire
   pass through untouched` (`test/model-profile.test.ts:157`). A dated
   supersession note was appended to the fragment; the transcript itself is
   untouched (write-once).

3. **The provider-lane probe's dual auth header — RECORDED (append-only dated
   note).** The provider arm sends BOTH `x-api-key` and `Authorization: Bearer`
   on one request (`test/vendor-anthropic-cache-probe.test.ts:416-422`). A
   dated watch-item note was appended to `docs/ledger/P8p-provider-lane-probe.md`:
   a 4xx is an AUTH-surface rejection, not a marker verdict; replay with only
   the target's expected header before recording.

4. **`/snapshot`'s client-fault workspace declaration — FIXED (red-first).**
   The W146 fragment's recorded review P3 ("/snapshot's resolveApplication has
   the SAME client-fault exposure and still answers 500 (pre-existing,
   unpinned)", `docs/ledger/W146-…md:48-50`). `/snapshot` reached the SAME
   `canonicalWorkspace` refusal as `/bash` and `/run/begin` but did not classify
   it, so a non-canonical workspace declaration rode the catch-all's 500. The
   route now catches `WorkspaceDeclarationError` → 400 with its message
   (`src/integrations/hub-http.ts:565-580`), mirroring the W146 pattern; every
   other resolver fault still rethrows to the 500. `test/hub-workspace.test.ts`
   tightened the `notEqual(200)` pin to `equal(400)` + named-message assertions
   for both the relative and the non-existent case, so the exposure can no
   longer hide behind the server-fault shape.

**Evidence:**

- RED (item 4, pre-fix `src/integrations/hub-http.ts`, the tightened pin),
  captured verbatim:
  ```
  not ok 1 - hub fails closed on an invalid workspace declaration
    error: |-
      a relative workspace declaration is a client fault (400), not a server fault
      500 !== 400
    code: 'ERR_ASSERTION'
    expected: 400
    actual: 500
    operator: 'strictEqual'
  # tests 4 / # pass 3 / # fail 1
  ```
- GREEN, focused suites (all exit 0):
  - `test/hub-workspace.test.ts` **4/4** (both faults now assert 400 + the
    named requirement).
  - `test/hub-workspace.test.ts` + `test/hub-snapshot.test.ts` +
    `test/hub-protocol.test.ts` **12/12**.
  - `test/e2e-hub-routes.test.ts` **1/1** (the spawned-hub route battery,
    including the `/snapshot` empty-body 400 classification).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).
- **Pre-existing, unrelated failure recorded honestly:** `test/workflow-hub.test.ts`
  is **4/5** on this branch AND on the branch base with the harvest edits
  stashed (`not ok 3 - workflow-hub CLI hides its inactive interactive seed and
  serves authorization` → "workflow-hub CLI did not create its discovery file"
  — a spawned-CLI harness failure, not touched by this change). Not fixed here;
  named so a green claim is not overstated.

**Recorded, NOT fixed (honestly):**

- **Item 1:** the daemon-hold/primitive unification (assessment and concrete
  follow-up above). Not small-safe enough for a harvest pass.
- **Item 2 / item 3:** recorded as dated append-only notes; no behavior change.
- **The W146 fragment's other residual** (`/run/begin`'s empty-runId and
  duplicate-runId 500s, and the duplicated try/catch shape) remains as
  recorded — out of this item's scope (a request-validation decision, not a
  workspace-declaration classification).
- **`lineageSnapshot` (`src/integrations/hub-http.ts:347`)** also calls
  `context.resolveApplication` without the `WorkspaceDeclarationError` guard;
  it is a different route and was not inspected in this pass — named as a
  candidate, not claimed.
