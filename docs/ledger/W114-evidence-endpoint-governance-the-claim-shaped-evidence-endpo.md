<!-- Ledger fragment: extracted from TASKS.md at line 3593 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W114 - Evidence-endpoint governance: the claim-shaped evidence endpoint removed, not gated (Complete - the fabrication path closed; the authorized-attach design stays queued) (2026-09-24)

**Source:** W110's discovered-and-queued trap — `POST /api/evidence`
accepted client-chosen `subject`+`result` as
HARDCODED-authority:"reviewer" kernel evidence from any same-origin
tab, satisfying a task's evidence gate from a claim. That is the exact
prohibition the W110 guard carried ("never a UI surface accepting prose
as kernel-gate evidence").

**What landed:**
- The `POST /api/evidence` route is REMOVED (src/ui/web.ts), not gated:
  the kernel's authority vocabulary (`environment|host|mcp|reviewer`,
  src/kernel/contracts.ts:17) has no honest class for an operator-typed
  claim, so no gate or re-scope could make the claim-shaped endpoint
  honest. The route's absence — the catch-all 404 for every origin, the
  removed route's own cross-origin 403 check having gone with it — plus
  an unchanged evidence snapshot are the closure observables
  (test/web.test.ts pins rewritten strong-only; the replaced pins
  asserted the hole-y behavior and are superseded, not silently
  weakened: the new set is strictly stronger for the closure).
- The webapp's `RecordEvidenceForm` is removed (src/ui/webapp/app.tsx);
  the Evidence panel stays read-only with an honest note (evidence
  records are produced by the hub's own flows; operator claims are not
  recorded). The honest producers are untouched: the run registry's
  `run:<id>` reviewer verdicts and the hub test runner's environment
  evidence.
- Deliberately NOT done: no kernel authority-vocabulary change (an
  operator/claim authority class is a kernel design with gate semantics
  of its own — its own iteration); the authorized-attach machinery
  (surface the producing flow per missing artifact) stays queued as the
  follow-on this unblocks.

**Acceptance criteria:**
- [x] No request shape can mint kernel evidence: POST /api/evidence
      returns the catch-all 404 for every origin, and the snapshot
      evidence list is unchanged by any attempt (the discriminating
      closure observables).
- [x] Red-first: with only the rewritten pins on the pre-change tree,
      21 pass/1 fail (exactly the closure pins fail against the live
      endpoint); green after: web 22/22, webapp family 47/0, the other
      web suites 57/0, lint + typecheck exit 0.
- [x] The read-only evidence panel remains, with the honest note that
      operator claims are not recorded.
- [x] The honest producers (run-registry verdict flow, test runner)
      unchanged — verified by the untouched src outside the removed
      route/form and the held-out suites.
