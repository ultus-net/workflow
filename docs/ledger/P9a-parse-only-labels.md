<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the P9 A′ parse-only observability landing, a landed work item. Write-once: append dated supersession notes, never rewrite. The P9 transform-governance decision STAYS queued for the operator (docs/PARKED_AND_LIMITATIONS.md:38; issue #288 open); A′ is observability-only and does not move it. -->

### P9 A′ - The messages-lane parse-only model-label capture (Complete - observability only; the transform-governance decision stays queued, issue #288 open) (issue #288 - the A′ option of the P9 brief, docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md:132-137) (2026-09-30)

**Source:** the P9 messages-lane governance brief (docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md,
landed in batch 5), option A′ (`:132-137`): "a parse-only lane branch that
records the request-side model id into the trail (closing W111's no-model-labels
gap) and never touches the forwarded body. Still 'untransformed' in the
governance sense — no shaping, no markers, no downgrade, no reject." The brief's
own verification row (`:201`) marks A′ as an offline pin with no live probes,
and its implementation sketch (`:344-351`) scopes it as "one parse-only capture
point + a pin". This subtask lands exactly that and nothing more.

**Scope verdict (recorded BEFORE code, per the brief's own words):**
IMPLEMENTABLE NOW. The brief separates A′ from the queued DECISION explicitly —
A′ is "the only change A admits that improves the trail without entering
transform governance" (`:134-137`); the recommendation holds the pass-through
stance and leaves the decision to the operator (`:309-338`), but A′ is not a
re-opening of that stance: it mutates nothing on the wire. The brief's own
bounds the change to one capture point + a pin, offline, no live probes
(`:201`, `:296-297`). Nothing in the P9 row (docs/PARKED_AND_LIMITATIONS.md:38)
or the brief gates the observability variant behind the transform-governance
decision; that decision governs shaping/markers/downgrade/reject, none of which
A′ touches.

**What landed:**
- `src/integrations/model-usage-proxy.ts` — a parse-only capture on
  `POST /v1/messages` (matched alongside `isCompletions`): the inbound body is
  parsed into a THROWAWAY record purely to read `body.model`; `outboundBody` is
  NEVER reassigned, so the forwarded bytes stay byte-identical to the inbound
  bytes. No shaping, no cache markers, no budget downgrade, no replay gate, no
  `usage.include` injection — the pass-through posture is untouched.
  - The request-side model id rides a new bounded journal
    (`messagesLaneLabels()`, `MessagesLaneLabels`): `models` in arrival order,
    capped at `MESSAGES_LANE_LABEL_LIMIT = 64` (oldest dropped; the repo's
    bounded-journal posture, `src/integrations/activity-timeline.ts:34`), plus
    `malformedBodies`. A malformed or non-object Messages body increments the
    counter and is FORWARDED RAW — the chat-completions lane's 400 posture is
    deliberately NOT adopted here (`src/integrations/model-usage-proxy.ts`, the
    messages branch and its comment).
  - DESIGN CHOICE (recorded): the label set is a bounded journal on the proxy,
    NOT a field on `ModelUsageMetrics`. The numeric metrics are summed across
    proxies by the pool (`src/integrations/open-model-proxy.ts:179-199`) and
    runtime (`src/integrations/acp-runtime.ts:155-168`) aggregates and read
    byte-identically by the W119 abort-tier snapshot; folding a categorical
    label set into that contract would perturb consumers rather than be
    additive. This matches the brief's allowance of "a bounded journal in the
    recorded pattern" and closes W111's no-model-labels gap
    (docs/ledger/W111-web-ui-c4-the-backend-measured-cost-headline-the-per-session.md:17)
    for this lane.
- `test/model-usage-proxy.test.ts` — four red-first pins: (1) the messages lane
  records the request-side model label AND the outbound body is byte-identical
  to the inbound bytes; (2) a malformed Messages body is counted, forwarded raw,
  and never 400s; (3) the journal is bounded at 64 and drops the oldest; (4) the
  default/no-op posture — the chat-completions lane never populates the
  journal. `test/session-budget.test.ts` — the five existing `ModelUsageProxy`
  mock literals gain the new accessor (mechanical; no behavior change).

**Evidence:**
- RED (pre-change source): the four new pins fail with
  `TypeError: proxy.messagesLaneLabels is not a function`; 19/23 pass
  (`git stash` of `src/integrations/model-usage-proxy.ts`, focused suite).
- GREEN: `node --import tsx --test test/model-usage-proxy.test.ts` — 23/23 pass,
  exit 0. Consumers: `test/session-budget.test.ts` 18/18, `test/open-model-proxy.test.ts`
  8/8, `test/budget-downgrade-auto-lane.test.ts` 6/6, `test/task-usage.test.ts` 4/4,
  all exit 0.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (unpiped).
- The outbound-byte pin asserts `upstream.seen[0]?.body === body` for the
  messages lane, so the "no wire transform" claim is executable, not asserted in
  prose.

**Deliberately NOT done:** no transform of any kind on the lane (no shaping, no
markers, no downgrade, no replay reject) — the P9 transform-governance half
STANDS and the DECISION stays the operator's (docs/PARKED_AND_LIMITATIONS.md:38;
issue #288 open). No live probes (A′ needs none, per the brief `:201`). No
change to `ModelUsageMetrics`, the pool/runtime aggregates, or the W119
abort-tier snapshot.
