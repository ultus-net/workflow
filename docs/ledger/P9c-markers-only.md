<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record of the P9 option C (markers-only) landing, a landed work item. Write-once: append dated supersession notes, never rewrite. The lane stays DARK by default (the P8 provider-lane probes remain the activation gate); option C implements the slice, it does not turn any family ON (issue #288). -->

### P9 C - The messages-lane markers-only slice, behind the DARK cache-marker opt-in (Complete - default byte-unchanged; the P8 provider-lane probes remain the activation gate) (issue #288 - option C of the P9 brief, docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md:164-179) (2026-09-30)

**Source:** the P9 messages-lane governance brief (docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md,
landed in batch 5), option C (`:164-179`): "Apply only `applyCacheMarkers` on
the messages lane, per-pool opt-in unchanged (absent stays absent)." The brief's
own sketch (`:353-372`) scopes it to a lane discriminator, a marker stage that
reuses `applyCacheMarkers` verbatim (it already gates on `cacheMarkersEnabled`
+ `wire === "anthropic"`), no `usage.include` injection on the messages wire,
`composeBodyTransforms` fail-open composition, and the opt-in left dark. The
operator approved option C as the P9 decision (issue #288). This subtask lands
exactly that and nothing more.

**Scope verdict (recorded):** the operator approved option C. The brief's own
dependency is honored, not waived: option C is "implementable and pinnable
offline but NOT production-enablable until P8 lands" (`:172-173`), and "the P8
provider-lane probes are UNRUN" (`:167-168`; docs/ledger/P8p-provider-lane-probe.md
— the harness exists, the live per-lane verdicts are operator-gated). So the
implementation ships the slice BEHIND the existing DARK opt-in and turns
NOTHING on: no default composition sets `cacheMarkers`, so the lane's default
posture stays byte-unchanged. Probe-gated, never date-gated.

**What landed:**
- `src/integrations/model-usage-proxy.ts` — a new `messagesTransformBody`
  option: the messages-lane transform seam, applied to the parsed
  `POST /v1/messages` body ONLY. `handle` now declares `outboundBody` before
  the messages branch; the A′ parse-only capture is unchanged (same journal,
  same malformed-body counter), and the parsed record is handed to the
  transform. The body is re-serialized ONLY when the transform returns a
  DIFFERENT object — an identity return (the dark-family / opt-in-off case)
  leaves the forwarded bytes byte-identical. A malformed or non-object body
  never invokes the transform and forwards raw (the A′ posture). Absent leaves
  the lane byte-unchanged (the A′ pass-through posture). The transform never
  adds `usage.include`, never shapes, never downgrades, never gates replay.
- `src/integrations/open-model-proxy.ts` — the pool composer supplies
  `messagesTransformBody` ONLY when `options.cacheMarkers !== undefined`, so
  the default pool never gets the seam (byte-unchanged by construction). The
  supplied stage looks up the pool profile by `body.model` against the same
  wire-threaded `profiles` map the chat-completions stages use and calls
  `applyCacheMarkers(profile, body)` — the W109 marker pass VERBATIM (its own
  per-family `cacheMarkersEnabled` gate + `wire === "anthropic"` gate). No
  `shapeRequestBody`, no downgrade stage: markers ONLY. A family omitted from
  the opt-in map yields `applyCacheMarkers` returning the input by reference,
  so that family stays byte-unchanged too.
- `test/model-usage-proxy.test.ts` — two red-first pins on the seam: (1) the
  transform fires on `POST /v1/messages` and its result is the forwarded body,
  while an absent transform forwards byte-unchanged; (2) an identity-returning
  stage never re-serializes the bytes and a malformed body is never handed to
  the stage (raw forward).
- `test/open-model-proxy.test.ts` — the end-to-end pin through the REAL pool
  composition (LESS-0030: no synthetic paths): an anthropic-wire pool with
  `cacheMarkers: { deepseek: true }` marks the deepseek messages body's system
  block and last tool definition with `cache_control: ephemeral`, leaves the
  per-turn `messages` array unmarked (the P13 boundary policy owns it), and
  injects no `reasoning`/shaping field; the glm family omitted from the map
  forwards byte-unchanged; a pool with no opt-in forwards byte-unchanged.

**Evidence:**
- RED (pre-change source, `git stash push -- src/integrations/model-usage-proxy.ts src/integrations/open-model-proxy.ts`, focused suites), verbatim:
  - `not ok 24 - P9 C: the messages lane applies the supplied transform; absent, the lane stays byte-unchanged` — `AssertionError`, expected `["messages"]` (the transform never fired). Suite: `# tests 25 / # pass 23 / # fail 2`.
  - `not ok 25 - P9 C: an identity-returning transform and a malformed body both leave the forwarded bytes byte-identical` — `AssertionError`, expected `1`, actual `0` (the transform was never invoked, so the "never invoked" counter pin is the discriminator). Suite: `# tests 25 / # pass 23 / # fail 2`.
  - `not ok 8 - P9 C: the anthropic-wire pool marks the messages lane's static head only when the opt-in enables the family` — `AssertionError`, expected `'ephemeral'` (the messages lane forwarded unmarked). Suite: `# tests 10 / # pass 9 / # fail 1`.
- GREEN (post-change, unpiped):
  - `test/model-usage-proxy.test.ts` 25/25, exit 0; `test/open-model-proxy.test.ts` 10/10, exit 0.
  - Consumers: `test/model-profile.test.ts` 18/18, `test/session-budget.test.ts` 18/18, `test/budget-downgrade-auto-lane.test.ts` 6/6, `test/task-usage.test.ts` 4/4, `test/open-source-pool.test.ts` 6/6, `test/vendor-anthropic-cache-probe.test.ts` 4 pass / 4 skip (ungated), all exit 0.
  - `npm run lint` exit 0; `npm run typecheck` exit 0 (unpiped).
- The byte-unchanged claim is executable: the pool pin asserts `upstream.seen[n]?.body === inboundBody` (string identity) for both the no-opt-in pool and the omitted-family case; the proxy pin does the same for an identity-returning stage and for the no-transform default.

**Deliberately NOT done:** no shaping, no budget downgrade, no replay gate, no
`usage.include` injection on the messages lane (option B and option D stay
open). No per-turn markers — the growing conversation stays uncached (option
C's static-head ceiling; the P13 boundary policy owns it). No family is turned
ON: every default composition leaves `cacheMarkers` undefined, so the lane
stays byte-unchanged until the operator's P8 per-lane verdicts land. The P8
provider-lane probe gate is unchanged (docs/ledger/P8p-provider-lane-probe.md;
issue #287 open). The A′ parse-only journal stays.
