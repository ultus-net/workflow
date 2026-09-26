<!-- Ledger fragment: extracted from TASKS.md at line 3640 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W115 - The permission-poll transport cap: an oversized parked payload stops riding the 1 s poll (Complete - the amplify vector dead; the answer-route posture unchanged) (2026-09-24)

**Source:** W112's queued transport note (the poll ships the parked FULL
input UNCAPPED at transport; the 64 KiB cap was render-side only) — the
exact gap W112's review round 1 flagged, named as belonging to the
evidence-endpoint governance scope.

**What landed:**
- The broker classifies the payload ONCE at parking (`classifyInput` —
  one pass producing the 2 KiB preview and the over-cap flag with the
  SAME measure the approval card renders: strings by length, objects by
  pretty-printed JSON length vs the 64 KiB PAYLOAD_INSPECTION_CAP) — so
  transport-strip and NOT-APPROVABLE-WITH-REASON are one classification,
  never two divergent ones. The parked in-memory request is untouched
  for the answer path.
- GET /api/permission shapes the pending through `transportPermissionView`:
  flagged payloads lose `input` and keep the explicit `inputOverCap` flag;
  unflagged requests pass through untouched (the VIEW is identity; the
  wire gains the required `inputOverCap: false` field — harmless, the card
  treats false and undefined identically). POST /api/permission's
  next-parked field is shaped through the same view (review round 1 P3).
- The card treats `inputOverCap === true` as NOT-APPROVABLE-WITH-REASON —
  LOAD-BEARING: without it, a stripped payload (input undefined) would
  skip the render-side cap check and render approvable — an approval
  without review, the exact regression the W112 discipline prevents. The
  flag is fail-restrictive only (a pure OR of disabling terms; it can
  never enable Allow).

**Acceptance criteria:**
- [x] The amplify vector is dead: an oversized parked payload (200 KiB in
      the pin) does NOT ride the poll; the response carries the flag and
      no input; the parked request still answers.
- [x] The under-cap path unchanged: the full input still transports (the
      identity-view pin), the card's approvable path untouched.
- [x] Red/green: 4 pins red on the pre-change tree (62 pass/4 fail —
      exactly the W115 pins), green after (67/67 across permission-broker
      + web + webapp-surface); held-out web suites 72/72; lint + typecheck
      exit 0.
- [x] The W112 transport note superseded with a dated note (append-only).

**Residuals (recorded, not fixed):** the answer route performs no
server-side approvability re-check (a direct POST with a valid id allows
an over-cap request regardless of the card) — the documented W112 posture
("a UI affordance gating the existing answer() route only"), unchanged by
W115; the under-cap wire GAINS `inputOverCap: false` (view-identity, not
byte-identity); the full input still parks in memory at the broker (the
agent's own spend — only the per-poll shipping is capped).
  - Dated note (2026-09-25, the base-loop continuation, iteration 49):
    the round-1 P3 above LANDED ONLY TODAY — the "What landed" list
    claimed it on 2026-09-24, but the merged commit (1e62f97) carried
    only the poll shaping; the answer-route line sat UNCOMMITTED in
    src/ui/web.ts until this session (the W134 deferral note "carries
    the operator's uncommitted W115 work" was the honest record). This
    iteration completed it: the answer route's `pending` rides
    `transportPermissionView` (src/ui/web.ts), the in-flight comment's
    race premise CORRECTED to the reachable truth (a concurrent
    same-session park is PROMPT_BUSY-denied and the field is read
    synchronously with the answer — the reachable non-null path is the
    legacy undefined-key shape, oldest parked overall), and the seam's
    own pin added: RED on the pre-change tree (25 pass/1 fail, the raw
    200 KiB payload in the answer response's `pending`), GREEN after
    (web 26/26; held-out permission-broker + webapp-surface +
    web-sessions 62/62; lint + typecheck exit 0). The under-cap identity
    pin rode along (a guard pin, green on both trees — its comment says
    exactly that). Fresh-eyes review: round 1 REJECT (the reviewer
    sandbox had no shell; four items unverified), the four closures
    cited file:line, round 2 APPROVE. LESS-0055 records the lesson.
