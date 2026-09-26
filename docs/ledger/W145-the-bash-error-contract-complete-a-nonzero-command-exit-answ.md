<!-- Ledger fragment: extracted from TASKS.md at line 5450 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W145 - The /bash error contract (Complete - a nonzero command exit answers 422 {error, exitCode} and client-shaped command faults answer 400; the W142 wave's findings (a) and (b) closed with deliberate pin flips) (2026-09-25)

**Source:** the W142 wave's findings (a) (a nonzero exit answers 500
with no exit-code field on the wire) and (b) (an empty command string
passes the route check and 500s in the executor) — the next loop
iteration per the operator's direction.

**What landed:**
- The /bash route's catch classifies the executor's exit error (the
  commandExitError factory attaches {exitCode} — run-controller.ts) as
  422 {error, exitCode}: the command's result is data, never a server
  fault. Server faults, the W144 timeout error, and guard/authorization
  denials carry no exitCode and keep the catch-all's 500.
- The route's command validation classifies the client-shaped faults
  400: an empty string command, an empty structured command, and
  non-string structured args (mirroring containedRequest's TypeErrors —
  the W134 route-classifies precedent).
- The four affected W142 pins flipped DELIBERATELY (3× 422 now asserting
  exitCode — strictly stronger; 1× 400), each with a dated note in the
  file header and at the pin.

**Acceptance criteria:**
- [x] Red-first: with hub-http.ts stashed, the flipped pins are red
      (422/400 asserted against the 500 answers); the W144 timeout pin
      stays green; green after 6/6 (e2e-hub-bash + hub-protocol); lint +
      typecheck exit 0.
- [x] Fresh-eyes review APPROVE (the classification closed — only
      run-controller.ts attaches exitCode to a thrown Error, so no
      non-exit error can misclassify; the route validation mirrors
      containedRequest exactly; the reviewer independently reproduced
      the red-first and the green run).

**Residuals (recorded, not fixed):** cwd-declaration faults (empty,
relative, nonexistent — a canonicalWorkspace TypeError outside the
W145 try) still answer 500 (client-shaped; the pre-existing W142 pin
stands; the fix shape is the same route-classification move and is
queued); /run/begin's client-shaped registry faults (W142's finding
(e)) need the typed-error refactor (the HubRequestError precedent) and
stay queued; the response-side output cap (finding (d)) stays queued.
  - Dated note (2026-09-25, W146): the cwd-declaration faults FIXED —
    the typed WorkspaceDeclarationError answers 400 at /bash and
    /run/begin (the W146 entry); the /run/begin registry-fault part of
    this residual (empty/duplicate runId) remains queued.
