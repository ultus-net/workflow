<!-- Ledger fragment: extracted from TASKS.md at line 3380 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W110 - Web-UI C3: refusal-legible evidence-gated transitions (Complete - the kernel refusal names the missing artifacts, the tasks panel renders it verbatim; the claim-shaped evidence endpoint discovered and queued) (2026-09-23)

**Source:** the pain-point queue's item 9, candidate C3 (the amux
research doc's first C-batch item), with its trust-boundary guard
carried into the item text: NEVER a UI surface accepting operator/agent
prose as kernel-gate evidence — Workflow's evidence must be
environment-supplied and kernel-validated.

**What landed:**
- Kernel (the refusal computation, pure): the EVIDENCE_REQUIRED
  rejection now names the UNSATISFIED requirements — each missing
  artifact with a per-requirement diagnosis discriminating no-evidence /
  wrong-authority / not-passing / stale ("the passing evidence is stale
  (a mutation landed after it)") — in the prose AND as a structured
  additive `missing` field on the rejected TransitionResult (absent on
  gates that do not produce it, never fabricated). The client never
  derives the refusal (the W107 guard pattern: the kernel computes, the
  UI relays).
- Webapp: `advance`/`retryTask` now RETURN the kernel's structured 409
  refusal (the pre-change UI discarded it with a bare
  `.then(() => refresh())`); the Tasks panel holds per-task refusal
  state and renders it verbatim beside the task (the step-rejection
  convention: role="alert", the refusal color, the machine code for the
  trail, and the missing artifacts as the per-entry artifact list).
- DISCOVERED AND QUEUED (the guard's exact trap, live): `POST
  /api/evidence` accepts client-chosen `subject`+`result` as
  HARDCODED-authority:"reviewer" kernel evidence from any same-origin
  tab — a same-origin page can satisfy a task's evidence gate by posting
  a claim. The kernel validates only subject/authority/result/freshness/
  epoch matching. The C3 "authorized attach path" design depends on
  governing this endpoint first (the honest producers that exist: the
  hub test runner's environment evidence at `test:<workspace>`, the
  axes-checked review verdict flow at `run:<id>`; the
  verification-accountability MCP observations never reach the kernel).
  Queued as the evidence-endpoint governance item — NOT silently kept.
  The authorized-attach machinery (surface the producing flow per
  missing artifact, route around the claim-shaped endpoint) is the
  follow-on item this legibility unblocks.

**Evidence:** red-first (the two kernel pins failed against the generic
prose) then green — kernel 11/11, the web 409 round trip carries the
structured `missing` + the enriched reason, the surface pin renders the
verbatim reason with the per-entry artifacts; 62/0 across task-graph +
web + webapp-surface; typecheck/lint exit 0.
   CORRECTION (review round 1, 2026-09-24): the "zero collateral" claim
was WRONG — the web.test.ts append SILENTLY DELETED the pre-existing
W107 C2 pin (`assert.equal(stateLegality.judged, 1)`), a gratuitous
test weakening the fresh-eyes reviewer caught by running the base file
against current src with the assertion restored (21/21 passes). The
assertion is RESTORED in this iteration's follow-up commit; the
zero-collateral discipline means the diff touching an existing test
block must re-include every line it did not intend to change — count
the lines you remove, not just the failures you add.

**Acceptance criteria:**
- [x] A withheld transition renders WHY: the kernel's refusal carries
      code + reason + the missing requirements with a per-requirement
      diagnosis, and the tasks panel renders it verbatim.
- [x] The client never derives the refusal — the kernel computes it
      (structured + prose) and the UI relays.
- [x] The claim-shaped evidence endpoint discovered and queued as its
      own governance item with the guard's citation.
- [x] The refusal transport for /api/transition and /api/tasks/retry
      unchanged (the 409 bodies were already structured — the UI now
      reads them).
