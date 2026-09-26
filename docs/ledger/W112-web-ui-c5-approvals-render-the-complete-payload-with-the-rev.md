<!-- Ledger fragment: extracted from TASKS.md at line 3511 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W112 - Web-UI C5: approvals render the complete payload with the review confirmation (Complete - the full payload retained and rendered, not-approvable-with-reason, the confirmation gate; the grant lifecycle queued) (2026-09-24)

**Source:** the pain-point queue's item 9, candidate C5 (the amux
research doc), with its guard carried into the item text: the approval
UI is a display-and-submission surface; no affordance bypasses the
application layer's authority.

**The exploration's decisive fact:** the broker ALREADY retains the full
proposal at parking (the action is in scope there) — the surface just
truncated it to a 2 KiB preview and dropped taskId/mutating/
requiredCapabilities/readFingerprints. Rendering the complete payload is
a surface change, not a retention change. Also decisive: the card
renders on policy-ALLOWED asks only (denials never prompt), and the
guard runs AFTER the operator answer on this lane (an approval can still
be tightened by a guard deny — the M3 posture, fail-closed).

**What landed:**
- The broker's `PendingPermissionRequest` carries the COMPLETE proposal
  payload: `input` (full, untruncated), `taskId`, `mutating`,
  `requiredCapabilities`, `readFingerprints` (as the inspected paths) —
  alongside the compact `inputPreview` (unchanged cap).
- The approval card renders the metadata row (mutating / capability /
  taskId / requires / reads), the FULL input up to the 64 KiB inspection
  cap, and the two C5 disciplines: the explicit "I have reviewed the
  full payload" confirmation REQUIRED before Allow (a UI affordance
  gating the existing answer() route only — it produces no kernel
  evidence, per the W110 hazard adjacency), and
  NOT-APPROVABLE-WITH-REASON when the payload exceeds the cap (Allow
  disabled, the reason states the cap verbatim, Deny never disabled —
  never approvable-with-warning).
- The grant lifecycle (expiry/ownership/consumption) is QUEUED as its
  own item: today's `allow_always` is tool-name-wide, immortal,
  in-memory (the opposite corner of the C5 grant design); the nearest
  building blocks are the opencode-server authority's single-use
  consumption maps and the provenance-store's fingerprint discipline.
  The degraded-hub behavior is mostly moot (the approval path is
  in-process, not hub-proxied) — recorded. Transport note (review round
  1 P3): the full input ships over the 1 s permission poll UNCAPPED at
  transport (the 64 KiB cap is render-side only) — a transport cap
  belongs to the evidence-endpoint governance item's scope.
  SUPERSEDED (W115, 2026-09-24): the poll now transports under the
  inspection cap — the broker classifies the payload once at parking and
  the poll route strips flagged payloads (see the W115 item); the
  answer-route approvability posture is unchanged.

**Evidence:** the broker pin (the parked request carries the full
payload — taskId/mutating/requiredCapabilities/readFingerprints mapped
to paths, the FULL input retained, the compact preview riding along),
the two card pins (the metadata + the confirmation gate statically
rendering Allow disabled pre-confirmation; the oversized payload
NOT-APPROVABLE-WITH-REASON with deny available), 85/0 across the
touched suites (permission-broker + web + surface + web-sessions +
step-ledger + operator-surfaces); typecheck/lint exit 0.
   CORRECTION (review round 1, 2026-09-24): the "typecheck/lint exit 0"
claim was FALSE at the reviewed tip — lint FAILED (the dead `rendered`
pre-computation assigned but never used) and the same line was a
reachable render crash (`payloadRenderText(undefined)` throws on an
optional ACP rawInput; the card has no error boundary). Both fixed in
this iteration's follow-up commit (the payload text computes INLINE in
the guarded render branch), the pin weaknesses the reviewer flagged
fixed (both allow affordances asserted gated), and the records
corrected here. Second lesson recorded: the pins caught the missing
render but NOT the dead variable — a pin proves what it asserts, never
that the rest of the file is clean; lint is the verifier for dead code
and must run at every tip.

**Acceptance criteria:**
- [x] The approval card renders the complete proposal payload (the full
      input + the authorization-relevant metadata previously dropped).
- [x] Allow requires the explicit "I have reviewed the full payload"
      confirmation (a UI affordance gating answer(); no kernel-evidence
      endpoint).
- [x] An uninspectable payload is NOT-APPROVABLE-WITH-REASON (Allow
      disabled with the cap stated; Deny available) — never
      approvable-with-warning.
- [x] The existing disciplines preserved (deny-on-cancel/switch, one
      prompt per session, the answer route's guards, policy still
      applies on remembered allows).
- [x] The grant lifecycle (expiry/ownership/consumption) queued with
      the building blocks named; the guard-overturn and degraded-hub
      facts recorded.
