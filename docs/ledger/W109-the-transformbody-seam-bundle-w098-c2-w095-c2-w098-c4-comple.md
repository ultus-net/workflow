<!-- Ledger fragment: extracted from TASKS.md at line 3239 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W109 - The transformBody seam bundle: W098 c2 + W095 c2 + W098 c4 (Complete - marker machinery + the composed seam landed; real-traffic effectiveness queued on the messages-lane governance gap; frontier round 1 REVISE, corrections applied, round 2 confirms) (2026-09-23)

**Source:** the pain-point queue's item 7 — the W098 c2 + W095 c2 bundle
(same transformBody seam) followed by W098 c4 (frontier verification of
the caching design, the Kimi K3 pattern). The queue's sub-item numbers
map to the acceptance-criteria bullets: W098 c2 = cache-control marker
injection at transformBody for anthropic-wire pools (opt-in per pool via
model-profile.ts); W095 c2 = the metering-proxy seam shaped for policy
routing (the autoLatest-style transform point) without changing the
pass-through posture for unclassified traffic; W098 c4 = the frontier
round. W098 c1 (the cache-bust audit) and c3 (the affinity spec) stay
queued — the ledger sequences c1 before affinity work only.

**W098 c2 — what landed (machinery + pins; real-traffic effectiveness
queued):** the per-pool opt-in (`ModelProfileInput.cacheMarkers` →
`ModelProfile.cacheMarkers`, absent stays absent) and the pure marker
pass (`applyCacheMarkers`): on the anthropic wire with the opt-in, the
STABLE composition-time prefixes get `cache_control: {type:
"ephemeral"}` — the system block (string → block array; array → last
block only, pre-existing markers preserved) and the last tool
definition; the per-turn message lane is untouched (its breakpoint
policy is deliberately undecided — see the queued decisions); opt-in
and wire-gated, absent-never-fabricated, never mutating.
`createOpenModelMeteringPool` threads the opt-in per pool and — the
prerequisite the pre-change composer dropped — the definition's `wire`
reaches the profile (anthropic-wire profiles were unconstructible).

**W095 c2 — what landed:** `createModelUsageProxy`'s `transformBody`
option is now the named POLICY-ROUTING transform point (the W095 design
note's second consumer attaches here), with the exported
`composeBodyTransforms` helper: ordered composition, per-stage
fail-open — a stage returning a non-record OR THROWING is skipped and
the chain continues with the last good body (frontier round 1 P2: the
fail-open extends to exceptions; a buggy policy consumer cannot 502 the
pool). The pass-through posture for unclassified traffic is unchanged
and pinned. Ordering guidance recorded for the budget consumer: a
model-rewriting stage attaches BEFORE the profile-shaping stage.

**DISCOVERED AND QUEUED (the load-bearing gaps the frontier round
shaped):**
1. **The messages-lane governance gap (P1, pre-existing W070b-era):**
   the proxy's parse/transform/usage-injection pipeline gates on the
   `/chat/completions` path only — the anthropic messages path passes
   through UNTRANSFORMED and effectively UNMETERED (clarifier, review
   round 1 P3: the lane does reach `recordUsage`, but the OpenAI-shaped
   extraction keys against the anthropic usage shape, so `usageEvents`
   can increment with zero tokens — the trail is polluted, not absent).
   The cache-marker pass therefore fires on real anthropic-wire traffic
   only after that lane is governed; the c2 end-to-end pin exercises the
   governed lane with an anthropic-wire profile. Queued as its own item
   (it needs the replay policy's Messages-schema compatibility and the
   anthropic usage shape recorded before the metering trail is trusted
   on that lane). RESOLVED-IN-PART (W123, 2026-09-24): the extraction
   half — the anthropic usage shape records real tokens (the pollution
   closed) and both prerequisite records landed — see the W123 item and
   park P9's dated note; the sentence above describes the as-found
   state, superseded on the metering half only.
2. **The cached-token metering blind spot (P2):** the metrics model
   knows only prompt/completion/total/cost — no cache_read/cache_create
   fields exist, so when markers fire on real traffic the cache-hit
   savings that justify the position are unobservable in the hub's own
   metering trail.
3. **The vendor-probe precondition (P2):** the position's "(Anthropic
   requires explicit markers; OpenAI-family auto-caches)" conflates
   Anthropic-the-vendor with the anthropic-compatible endpoints the
   pools would hit (api.deepseek.com/anthropic, api.z.ai/api/anthropic,
   api.moonshot.ai/anthropic) — their cache_control acceptance is
   UNPROBED, and a rejecting endpoint turns the opt-in into a
   per-request 400. The opt-in stays documented as dark until
   per-vendor probes land (probe-gated, never date-gated).
4. **The message-lane breakpoint policy (P2, deferred deliberately):**
   the anthropic wire allows a small number of breakpoints and caches
   only at marked prefix ends; the minimal slice marks the static head
   only, so the growing conversation — the dominant token mass — is
   never cache-read until the per-turn boundary policy is decided. The
   deferral is recorded as load-bearing, not a footnote.
5. The hub-side prefix discipline governs a minority of the prefix: on
   the default surface the system prompt and tool serialization are
   composed by OpenCode (host-composed), so W098 c1's cache-bust audit
   must extend into host-composed prefixes (the environment block,
   compaction rewrites, mid-session tool churn) — the position's "(a)
   the hub composes the largest prefixes" was over-powered and is
   corrected in the W098 item.
6. Opt-in granularity: the composer flag covers all keyed families at
   once (coarser than per-vendor-pool); per-family granularity queued.

**W098 c4 — the frontier verification record (round 1, 2026-09-23):
REVISE.** Kimi K3 via the `general` subagent (model
openrouter/moonshotai/kimi-k3), fresh context, read-only, adversarial
brief (falsify the position, the marker design, the opt-in surface, the
seam composition, the metering-trail constraint). Findings, verified
against code by the verifier and incorporated the same day: P1 ×2 (the
synthetic-path end-to-end pin + the unrecorded messages-lane blocker;
the glm/kimi anthropic mis-shape via the new wire threading), P2 ×4
(the deferred breakpoint unrecorded; the fail-open narrower than its
doc — throwing stages propagated; the vendor premise conflated and the
compat endpoints unprobed; the cached-token metering blind spot), P3
×4 (opt-in granularity, the ordering guidance, the fallback-slug
affinity scope, the debug debris). The verifier also confirmed the
sound spine: pure marker pass, opt-in/wire-gated,
absent-never-fabricated, pass-through preserved, the response-caching
rejection sound, the deterministic-TTL model sound. Round 2 (the same
session, continuation) verifies the corrections below.

**W098 position corrections (dated, append-only):** (1) "(Anthropic
requires explicit markers; OpenAI-family auto-caches)" conflates
Anthropic-the-vendor with the anthropic-compatible wire — the Messages
SCHEMA requires markers; whether the three compat endpoints accept them
is UNPROBED (the opt-in stays dark until probed). (2) "(the hub
composes the largest prefixes: system prompts, fleet guidance, tool
definitions, per-role model config)" is over-powered — on the default
surface the system prompt and tool serialization are composed by
OpenCode (host-composed); the hub composes the orientation block,
per-turn advisory guidance, MCP mounts, and the loop prefix, and c1's
audit must extend into host-composed prefixes.

**Evidence:** red-first (4 compile-level marker tests + the
composition/pool behavioral tests failing with zero collateral) then
32/0 (model-profile 13 + model-usage-proxy + open-model-proxy), plus
the held-out replay/schema/budget suites (9 pass) and the repo
typecheck/lint exit 0. The frontier round ran its own suite checks
(31/31 at its pre-fix state). The round's process notes: the verifier
correctly flagged that the iteration was uncommitted worktree state
(normal pre-commit) and that the W109 item did not yet exist (it was
authored after the round, as the corrections).

**Acceptance criteria:**
- [x] W098 c2 (machinery + pins; the two-sided honest scope in the
      queued list): the marker injection at transformBody, opt-in per
      pool via model-profile.ts, wire-gated, absent-never-fabricated.
- [x] W095 c2: the seam shaped for policy routing (the composition
      helper + the named second consumer) with the pass-through posture
      unchanged for unclassified traffic (pinned: empty chain, non-record
      stages, throwing stages, unknown-model traffic).
- [x] W098 c4: the frontier verification ran and its corrections landed
      (Kimi K3, fresh context, adversarial; round 1 REVISE with 2×P1 +
      4×P2 incorporated; round 2 confirms).
- [x] The discovered gaps queued with their costs (the messages-lane
      governance, the vendor probes, the breakpoint policy, the
      cached-token metering fields, the c1 audit scope).
