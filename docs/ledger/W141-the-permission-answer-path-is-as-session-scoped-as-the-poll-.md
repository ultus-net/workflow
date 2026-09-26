<!-- Ledger fragment: extracted from TASKS.md at line 5222 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W141 - The permission answer path is as session-scoped as the poll (Complete - broker.answer's ownership check ends the cross-session answer consumption the W140 wave observed; the FINDING pin flipped deliberately) (2026-09-25)

**Source:** the W140 wave's finding (recorded 2026-09-25, this branch's
wave round): GET /api/permission filters the parked set by the session's
permission key, but POST /api/permission resolved by parked id ALONE —
answering through session B's route with session A's parked id returned
200, resolved A's park (OPERATOR_REJECTED), and A's poll afterwards
showed null. The operator's "fix the next item" direction.

**What landed:**
- `PermissionBroker.answer` gains an optional `sessionKey` ownership
  check: a caller-scoped key must OWN the parked request (the parked
  entry's sessionKey is fixed at parking from the action's correlation
  id); a mismatched key answers nothing. `undefined` keeps the legacy
  unscoped shape — consistent by construction: the keyless channel's
  poll surfaces the OLDEST parked request overall, so what it shows is
  what it may answer.
- `SessionChannel.answerPermission` passes its own key — the channel is
  the only src caller (web.ts:709), so the refusal rides the route's
  EXISTING 404 branch ("unknown or stale permission request"); no route
  logic changed. `cancelPending` was already keyed; the answer now
  mirrors it.
- Pins: a broker-level ownership pin (mismatched key refuses; the park
  survives; the owning key resolves; B's park answers independently) +
  the W140 FINDING test FLIPPED DELIBERATELY (cross-session 404 + the
  park survives + the positive control through A's own route; the file
  header and the in-test comment record the flip with the pre-fix truth
  pointer).

**Acceptance criteria:**
- [x] Red-first: with only the two src changes stashed, exactly the two
      W141 pins are red (the broker pin: answer ignored the key → true ≠
      false; the web pin: cross-session 200 ≠ 404); green after:
      101/101 across permission-broker + web-scoping + web +
      web-sessions + webapp-surface; lint + typecheck exit 0.
- [x] Fresh-eyes review: [APPROVE] on the code (the ownership check
      verified airtight — the only src caller is the channel; the
      web-sessions pin stays green by construction; the residual-shape
      audit found no second unscoped consumption seam; the ACP answer
      path never touches broker.answer), with two P2 record defects
      (the stale in-file FINDING block; the missing ledger rows) repaired
      before this entry.

**Residuals (recorded, not fixed):** the keyless window (a channel whose
driver reports neither permissionSessionKey nor agentSessionId) still
polls and answers the oldest parked request OVERALL — poll and answer
AGREE in that window, so the "as scoped as the poll" contract holds, but
cross-session consumption remains reachable there by design (the legacy
single-session posture); the window only opens for degenerate drivers
(the manager always wires a key function, web-sessions.ts:460). A parked
entry with sessionKey === undefined can never be answered by a keyed
caller (fail-closed on degenerate data).
