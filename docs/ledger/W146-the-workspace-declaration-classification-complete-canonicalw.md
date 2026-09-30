<!-- Ledger fragment: extracted from TASKS.md at line 5494 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W146 - The workspace-declaration classification (Complete - canonicalWorkspace's two faults throw the typed WorkspaceDeclarationError and /bash + /run/begin answer 400; the W142 wave's cwd findings closed with three deliberate pin flips) (2026-09-25)

**Source:** the W145 residual's queued cwd-declaration faults and the
third member of W142's finding (e) family (the non-canonical
workspace). The next loop iteration per the operator's base-loop
direction.

**What landed:**
- `run-registry.ts`: `WorkspaceDeclarationError extends TypeError` —
  thrown by `canonicalWorkspace` for BOTH faults (non-absolute;
  not-an-existing-directory), messages unchanged. Subclassing TypeError
  preserves `.name === "TypeError"` so message-format pins elsewhere
  survive, and any external `instanceof TypeError` catch keeps working
  (none exist in-repo, grep-verified at landing time).
- `hub-http.ts`: /bash wraps `context.resolveApplication` and /run/begin
  wraps `runController.begin` in try/catch → 400 `{error: message}` for
  WorkspaceDeclarationError, everything else rethrown to the catch-all.
  Empty runId and duplicate runId keep their 500s (recorded, not fixed,
  still queued under W142's finding (e)).
- Refusal semantics unchanged: canonicalization runs BEFORE composition
  (begin validates → duplicate check → canonicalize → compose/addTask),
  so nothing composes and no run task is created — the W139 run-now
  safety story (the fire refuses at controller.begin on a
  non-canonicalizable workspace) depends on the refusal, not the status
  code, and is preserved.
- Three W142 pins flipped DELIBERATELY (dated notes at the pins and in
  the file header): /bash emptyCwd 500→400, /bash relativeCwd 500→400,
  /run/begin non-canonical 500→400. The e2e-hub-schedule.test.ts
  refusal-message pin (the scheduler's "could not begin run: declared
  workspace is not an existing directory") needed NO flip — the message
  and the refusal are unchanged.

**Acceptance criteria:**
- [x] Red-first: with the two src files stashed, the first flipped pin
      is red (expected 400 / actual 500 at emptyCwd; the single-block
      suite aborts there); green after: e2e-hub-bash 2/2, held-out
      hub-protocol + e2e-hub-routes + e2e-hub-schedule 7/7; lint (the
      W146 files clean; one unrelated error in an uncommitted wave
      file) + typecheck exit 0.
- [x] Fresh-eyes review APPROVE (five axes; the classification closed —
      WorkspaceDeclarationError is thrown at exactly two sites, and a
      plain TypeError from begin's empty-runId does not satisfy
      instanceof, so the 500 pins stay honest; refusal-before-composition
      verified in source).

**Residuals (recorded, not fixed):** /snapshot's resolveApplication has
the SAME client-fault exposure and still answers 500 (pre-existing,
unpinned — the review's P3); /run/begin's empty-runId and
duplicate-runId 500s remain queued (W142 finding (e)); the
try/catch-rethrow shape is now duplicated at two call sites — extract a
helper if a third route adopts the classification (the review's P3
nit).

> **Dated note (2026-09-30, branch `feat/harvest-4`):** two of these residuals
> moved. (1) `/snapshot`'s resolveApplication client-fault exposure was FIXED in
> the harvest-3 pass (typed `WorkspaceDeclarationError` → 400; see
> `docs/ledger/residual-harvest-3.md` item 4). (2) `/run/begin`'s EMPTY/
> whitespace runId/title 500 was FIXED in the harvest-4 pass — the route
> validates trimmed non-emptiness before the registry is reached and answers the
> named 400 `{ error: "invalid run begin request" }`
> (`src/integrations/hub-http.ts:241-252`; red-first pin in
> `test/hub-runs.test.ts`, the compiled-hub pin in `test/e2e-hub-bash.test.ts`
> flipped 500→400). The DUPLICATE-runId 500 remains queued (it fires inside the
> registry and needs a typed registry error or a membership lookup — W142
> finding (e)); the duplicated try/catch-rethrow shape remains (extract a helper
> only if a third route adopts the classification).

> **Dated note (2026-09-30, branch `feat/harvest-6`):** both remaining
> residuals above are now closed. (1) The duplicate-runId 500 was closed in
> harvest-5 (typed `DuplicateRunError` → 409; `residual-harvest-5.md` item 2).
> (2) The duplicated try/catch-rethrow shape was extracted in harvest-6 as the
> shared `sendClientFault` helper (`src/integrations/hub-http.ts`), consumed at
> all FIVE `WorkspaceDeclarationError` sites (`/run/begin` + the 409
> `DuplicateRunError`, `/snapshot`, `/schedule/list`, `/board/delegate`,
> `/bash`) — the fragment's "if a third route adopts" condition is met, and
> harvest-5's "THREE call sites" count is corrected to five
> (`residual-harvest-6.md` item 1).
