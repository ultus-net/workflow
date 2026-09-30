<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the P9 option D (Messages-schema replay integrity check) landing, a landed work item. Write-once: append dated supersession notes, never rewrite. The tier ships DARK (the explicit opt-in defaults off); the host-body audit remains its production gate, and option B stays open (issue #288). -->

### P9 D - The messages-lane Messages-schema replay integrity check, behind the DARK opt-in (Complete - default byte-unchanged/no reject; the host-body audit remains the production gate) (issue #288 - option D of the P9 brief, docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md:181-192, :393-406) (2026-09-30)

**Source:** the P9 messages-lane governance brief (docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md,
landed in batch 5), option D (`:181-192`): "Not a transform: a fail-closed
REJECT tier on the messages lane for malformed replays (tool_use blocks
unattributed to tool_results; thinking-signature replay integrity)". The
brief's own sketch (`:393-406`) scopes it to a new PURE module in
`src/integrations/` (sibling to `model-replay-policy.ts`), a detector whose
signature is `detectMessagesSchemaReplayViolations(messages)`, enforcement at
the messages branch, and the host-body audit BEFORE the reject goes live. The
brief's own compatibility warning (`:187-192`, `:268-270`, `:291-292`) is the
primary constraint: the W070b sanctioned synthetic-tool-call path IS this
lane's traffic, so the tier must not false-reject the insertions the replay
policy routes here. This subtask lands the detector + the tier, dark, and
nothing more.

**Scope verdict (recorded):** the brief calls option D "record-supported and
orthogonal" (`:334-336`) and implementable offline with the reject tier's LIVE
gate being the host-body audit (`:289-292`). So the implementation ships the
tier BEHIND an explicit opt-in and turns NOTHING on: no default composition
sets the opt-in, so the lane's default posture stays byte-unchanged and
reject-free. Probe/audit-gated, never date-gated.

**What landed:**
- `src/integrations/messages-replay-integrity.ts` — the new PURE module (no
  IO, no model id, no vendor contract; the Messages schema is structural):
  - `MESSAGES_REPLAY_POLICY = "messages-replay-integrity"` — the named policy
    under which a refusal is structured.
  - `detectMessagesSchemaReplayViolations(messages)` — the messages-lane
    sibling of `detectSyntheticToolCallTurns`. Three deterministic structural
    signals: an assistant `tool_use` never answered by a following
    `tool_result` (`unanswered-tool-use`); a `tool_result` with no PRECEDING
    `tool_use` carrying its `tool_use_id` (`unattributed-tool-result`); a
    `thinking` block whose preserved `signature` was stripped
    (`missing-thinking-signature`). Ordering is by array index (a `tool_use`
    must precede its result; a result must follow its use), so parallel and
    reordered results within one turn remain attributed and pass.
  - `enforceMessagesReplayIntegrity(body)` — allow, or a structured rejection
    with the named reason `messages-schema replay integrity check rejected the
    request: N violation(s)`. A body with no `messages` array fails closed
    (`missing-messages`).
  - `unparseableMessagesBodyRejection()` — the fail-closed refusal for a body
    that is not a parseable JSON object (`unparseable-body`): under the opt-in
    an unverifiable body cannot be proven replay-safe, so it is refused rather
    than forwarded.
- `src/integrations/model-usage-proxy.ts` — a new `messagesReplayIntegrity`
  option (`boolean`, DEFAULT undefined/false = DARK). On the
  `POST /v1/messages` branch, under the explicit opt-in only: a parsed body the
  detector flags is refused with the structured 400
  `{ error, policy: "messages-replay-integrity", violations }` BEFORE any
  transform or forward; an unparseable body fails closed the same way. No
  opt-in: the A′ pass-through posture is untouched (byte-unchanged, no reject,
  malformed bodies still counted and forwarded raw). This is a correctness
  control, never a transform — it never rewrites a forwarded body.
- `src/integrations/open-model-proxy.ts` — an explicit `messagesReplayIntegrity`
  pool option, passed to each family proxy ONLY when `=== true`. No default
  composition sets it, so the default lane stays dark by construction.
- `test/messages-replay-integrity.test.ts` — 8 pure-detector pins (allow the
  plain conversation, the matched pair, the parallel pair, the signed thinking
  block; refuse the dangling tool_use, the orphaned result, the unsigned
  thinking block, the missing-messages body; the unparseable refusal shape).
- `test/model-usage-proxy.test.ts` — 4 proxy pins: (1) no opt-in -> unsafe
  shape forwards byte-unchanged (dark default); (2) opt-in -> unsafe shape is
  refused with the named reason before upstream, structured under its own
  policy; (3) opt-in -> the W070b sanctioned synthetic insertion is allowed and
  forwards byte-unchanged; (4) opt-in -> an unparseable body fails closed.
- `test/open-model-proxy.test.ts` — 1 end-to-end pin through the REAL pool
  composition (LESS-0030: no synthetic paths): an opted-in pool refuses the
  unsafe messages replay and allows the sanctioned insertion; the DEFAULT pool
  leaves the lane dark.

**THE W070b COMPATIBILITY PIN (the recorded primary risk):** the tier permits
a MATCHED synthetic `tool_use`/`tool_result` pair — the insertion the replay
policy's `route-anthropic` decision routes to this lane — so it cannot
contradict the policy that sends those turns here. The proxy pin (3), the
pool pin, and the pure `SANCTIONED_SYNTHETIC_INSERTION` pin all assert the
matched pair is allowed; only the UNPAIRED halves are refused. A naive
detector that flagged every tool_use/tool_result turn would false-reject the
sanctioned path — this is the exact failure mode the pins discriminate.

**Evidence:**
- RED (tests authored FIRST against the pre-change source), verbatim:
  - `test/messages-replay-integrity.test.ts` — `ERR_MODULE_NOT_FOUND` for
    `.../src/integrations/messages-replay-integrity.js`; `# tests 1 / # pass 0 / # fail 1`.
  - `test/model-usage-proxy.test.ts` —
    `not ok 29 - P9 D: under the opt-in an unsafe replay shape is refused with the named reason before upstream`
    and
    `not ok 31 - P9 D: under the opt-in an unparseable messages body fails closed with the named reason`;
    `# tests 31 / # pass 29 / # fail 2` (the dark-default and sanctioned-pair pins passed pre-change by design — they assert the baseline).
  - `test/open-model-proxy.test.ts` —
    `not ok 10 - P9 D: the pool's replay-integrity opt-in refuses an unsafe messages replay; the default pool stays byte-unchanged`;
    `# tests 12 / # pass 11 / # fail 1`.
- GREEN (post-change, unpiped):
  - `test/messages-replay-integrity.test.ts` 8/8, exit 0;
    `test/model-usage-proxy.test.ts` 31/31, exit 0;
    `test/open-model-proxy.test.ts` 12/12, exit 0.
  - Replay consumers unchanged: `test/model-replay-policy.test.ts` +
    `test/model-replay-proxy.test.ts` 14/14, exit 0.
  - Adjacent consumers: `test/session-budget.test.ts` 18/18,
    `test/model-profile.test.ts` 24/24, `test/task-usage.test.ts` 6/6,
    `test/open-source-pool.test.ts` 6/6, `test/budget-downgrade-auto-lane.test.ts`
    6/6, all exit 0.
  - `npm run lint` exit 0; `npm run typecheck` exit 0 (unpiped).
- The byte-unchanged default is executable: the proxy pin asserts
  `upstream.seen[0]?.body === DANGLING_TOOL_USE_BODY` (string identity) with no
  opt-in; the pool pin asserts the default pool's lane stays 200/no-reject.

**Deliberately NOT done:** no activation — no default composition sets
`messagesReplayIntegrity`, so the tier is DARK by default and the lane stays
byte-unchanged until the host-body audit lands (the brief's option D
production gate, `:289-292`). No shaping, no markers, no budget downgrade
(option B stays open; the cache-marker slice is P9c's, behind its own opt-in).
No `usage.include` injection on the messages lane. The A′ parse-only journal
stays. No live probes here (the detector is pinned offline; the host-body audit
and host-adapter probes are operator-gated). Issue #288 stays open.
