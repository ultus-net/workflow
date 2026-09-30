# P9 — the messages-lane transform+metering governance brief

**Issue:** #288 · **Date:** 2026-09-30 · **Kind:** DECISION INPUT (docs-only; no code, no policy change)

**Status:** The lane stays untransformed as recorded (docs/PARKED_AND_LIMITATIONS.md:38,
operator-approved 2026-09-24). The DECISION stays the operator's — this brief informs
whether that stance holds or changes; it decides nothing and implements nothing.

---

## 1. The gap and what landed

### 1.1 The gap (the record's own statement)

Park P9 (docs/PARKED_AND_LIMITATIONS.md:38): "the pipeline gates on /chat/completions —
the anthropic messages path passes through UNTRANSFORMED and effectively UNMETERED",
sharpened by W109's review round 1: the lane DID reach `recordUsage`, but the
OpenAI-shaped extraction keyed `prompt_tokens`/`completion_tokens` against the
anthropic usage shape, so every anthropic event landed as `usageEvents += 1` with ZERO
tokens — "the trail is polluted, not absent". The mechanics in the source:

- **The gate:** `src/integrations/model-usage-proxy.ts:302` — `isCompletions` matches
  `POST .../chat/completions` only. Everything else (the anthropic Messages lane,
  `POST /v1/messages`) takes the raw-forward path (`outboundBody = inbound`,
  `src/integrations/model-usage-proxy.ts:303`): no JSON parse, no replay enforcement,
  no Auto Router resolution, no `transformBody`, no `usage.include` injection — the
  whole parse/transform/usage-injection block (`src/integrations/model-usage-proxy.ts:304-366`)
  sits inside the gated branch.
- **The governance half:** no shaping (W070a profile shaping), no cache markers (the
  W109 marker pass), no budget-downgrade rewrite (the W118 stage) ever fires on the
  lane — the downgrade stage and the caller's composed chain are applied only inside
  the gated branch (`src/integrations/model-usage-proxy.ts:266-271, :359-362`).
- **The metering half (pre-W123):** response-side extraction keyed the OpenAI shape,
  recording zero-token events (the W109 review round-1 correction,
  docs/ledger/W109-the-transformbody-seam-bundle-w098-c2-w095-c2-w098-c4-comple.md:47-49).

### 1.2 What landed — the trail is now trustworthy

- **W123 (2026-09-24) — the extraction corrected (P9 part 1):** the extraction keys on
  the anthropic wire type (`type: "message"` JSON, `message_start`/`message_delta` SSE)
  — the type the chat-completions lane never carries, so it cannot misclassify
  (`src/integrations/model-usage-proxy.ts:463-466, :408-414`); the cache components
  normalize INTO the prompt side (anthropic reports them outside `input_tokens`, OpenAI
  includes them in `prompt_tokens`, so the W045/W118 caps mean the same thing on both
  lanes — `src/integrations/model-usage-proxy.ts:480-518`); the cumulative SSE stream
  merges last-observed-per-field into ONE usage event per message, never summed across
  events (the langchainjs #10249 double-count hazard —
  `src/integrations/model-usage-proxy.ts:388-435`); the raw anthropic fields ride
  `onUsage` (P12's seam, `src/integrations/model-usage-proxy.ts:519-522`); the cost
  boundary (the anthropic usage carries no cost field — the lane's local cost is
  unmeasured, bounded server-side by the OpenRouter per-key credit limit) and the
  transform boundary (the lane stays untransformed) recorded in the extraction's docs
  (`src/integrations/model-usage-proxy.ts:490-500`). Landing evidence: 19/19
  model-usage-proxy + 23/23 consumers, lint + typecheck exit 0
  (docs/ledger/W123-the-anthropic-messages-lane-meters-honestly-the-extraction-s.md:43-54).
- **P12 (2026-09-27, PR #311) — the cache fields first-class:**
  `cacheReadTokens`/`cacheCreateTokens` meter first-class on the lane from W123's seam
  (never re-derived from the wire), summed through the pool/runtime aggregates, the
  hub's per-run `RunUsageSummary`, /snapshot, and the timeline
  (`src/integrations/model-usage-proxy.ts:511-515`; the P12 supersession note,
  docs/ledger/W109-the-transformbody-seam-bundle-w098-c2-w095-c2-w098-c4-comple.md:144-160;
  docs/PARKED_AND_LIMITATIONS.md:41).
- **W109 (2026-09-23) — the transform machinery exists but is lane-bound:** the marker
  pass (`applyCacheMarkers`: per-pool opt-in, wire-gated to the anthropic wire, static
  head only — system block and last tool definition, absent-never-fabricated,
  pre-existing markers preserved, never mutating,
  `src/integrations/model-profile.ts:228-248`), the composed seam
  (`composeBodyTransforms`: ordered, per-stage fail-open,
  `src/integrations/model-usage-proxy.ts:42-61`), and the composed governed lane in
  `createOpenModelMeteringPool` (shaping then markers keyed by `body.model` against
  wire-threaded profiles, `src/integrations/open-model-proxy.ts:102-139`) — all applied
  on the chat-completions lane only. Real-traffic marker effectiveness was queued ON
  this governance gap (docs/ledger/W109-...comple.md:3, :50-52).

**Consequence for this decision:** the park row's stated prerequisites for governing
the lane have landed — the anthropic usage shape and the replay policy's
Messages-schema compatibility record (docs/ledger/W123-...extraction-s.md:15-24) — so
the trail can now be trusted to MEASURE any governance choice. The binding constraints
that remain are probe constraints (P8 + the separately-unrun GLM/Kimi anthropic-wire shape probes), not record constraints.

### 1.3 What stays open on the lane even after W123

- The transform-governance half: untransformed (no shaping/markers/downgrade) — this
  brief's subject (docs/PARKED_AND_LIMITATIONS.md:38, "STANDS").
- The Messages-schema replay integrity check (tool_use / thinking-signature replay):
  the explicitly queued successor decision
  (docs/ledger/W123-...extraction-s.md:21-24; `src/integrations/model-usage-proxy.ts:496-500`).
  The messages lane is W070b's sanctioned synthetic-tool-call transport (the
  `route-anthropic` action, `src/integrations/model-replay-policy.ts:70-75, :260-269`)
  and is replay-UNGATED by recorded decision.
- The SSE mid-stream reader failure loses the buffered pending record (no emit) where
  the chat-completions lane keeps partial parse-time usage — recorded residual,
  unmeasured and unpinned after P12 (docs/ledger/W123-...extraction-s.md:76-82, :93-94).
- No model labels in the trail (W111's gap,
  docs/ledger/W111-web-ui-c4-the-backend-measured-cost-headline-the-per-session.md:17) —
  usage events carry no request-side model attribution.
- P13: the per-turn breakpoint policy — even with markers enabled, the static-head-only
  slice leaves the growing conversation (the dominant token mass) never cache-read
  (docs/PARKED_AND_LIMITATIONS.md:42; W109 gap 4, docs/ledger/W109-...comple.md:73-78).

---

## 2. The options as the record implies

### A — Hold the pass-through stance (status quo)

No shaping, no markers, no downgrade, no replay gate on the messages lane. Requests
forward byte-faithful (`src/integrations/model-usage-proxy.ts:301-303, :368-383`);
metering stays response-side content-keyed (W123's extraction). What that leaves
unobservable/uncached:

- No cache markers on the lane → `cacheRead`/`cacheCreate` stay at whatever the
  endpoint does by default (on anthropic-schema endpoints, effectively zero without
  markers) → the cache-hit savings that justify the caching position are unrealized on
  the lane, even though the metering that would observe them now exists (P12).
- The W118 WARN-tier downgrade is inert on messages-lane sessions (the stage never
  runs there); a session that lives on the lane is governed only by the abort tier
  (W045, aggregated across lanes since W119, which now sees the lane's real token
  mass — `src/integrations/model-usage-proxy.ts:488-490`).
- The W070a wire invariants (GLM/Kimi never `thinking.type: "disabled"`) are unenforced
  at this lane's boundary — a host that composes openai-wire thinking fields into a
  messages body forwards them raw to the vendor.
- Malformed Messages bodies pass unchecked (replay-ungated by recorded decision).
- No model labels in the trail (W111's gap).
- The lane's dollar cost stays unmeasured (no cost field in the anthropic usage shape —
  `src/integrations/model-usage-proxy.ts:490-493`).

Note: the lane is not credential-ungoverned — the W052 egress-credential check applies
pre-branch (`src/integrations/model-usage-proxy.ts:284-300`); what is ungoverned is the
body, not the credential.

### A′ — the observability variant of A (parse-for-labels only)

The only change A admits that improves the trail without entering transform governance:
a parse-only lane branch that records the request-side model id into the trail (closing
W111's no-model-labels gap) and never touches the forwarded body. Still "untransformed"
in the governance sense — no shaping, no markers, no downgrade, no reject.

### B — Shape the lane (apply the transform pipeline's shaping)

Extend the gated branch to the messages path: parse, then run a messages-scoped
transform chain — the W118 downgrade stage (before shaping, per the W109 ordering
guidance) and the W070a profile shaping keyed on `body.model` against the same
wire-threaded profiles. What the record requires FIRST:

- **The replay policy's Messages-schema compatibility record — LANDED**
  (docs/ledger/W123-...extraction-s.md:21-24): `enforceReplayPolicy` stays
  chat-completions-scoped (`src/integrations/model-replay-policy.ts:245-272` applies to
  a Chat Completion body); the anthropic-messages transport is W070b's sanctioned
  synthetic-tool-call path and remains replay-ungated. B does NOT require extending the
  replay gate; B and the successor integrity check (option D) are separable axes.
- **Verified anthropic-wire vendor shapes:** deepseek's anthropic branch is wired as
  documented (`reasoning: { effort }`, `src/integrations/model-profile.ts:145-147`);
  GLM/Kimi's anthropic-wire shapes are SCRUB-UNTIL-PROBED — the openai-wire fields are
  dropped rather than an invented shape passed through, and "wiring the verified
  anthropic thinking shape for GLM is queued" (`src/integrations/model-profile.ts:150-159, :163-169`;
  W109 frontier round-1 P1, docs/ledger/W109-...comple.md:94-99). So B's production
  gate is a LIVE shape probe (a P8-sibling probe on the same harness pattern), not new
  records.
- **A malformed-body posture decision:** the chat-completions branch 400s malformed
  JSON (`src/integrations/model-usage-proxy.ts:307-311`); the messages lane today
  forwards raw bytes. Parsing the lane makes the 400-vs-fail-open-skip choice explicit.

### C — Markers-only (cache_control opt-in)

Apply only `applyCacheMarkers` on the messages lane, per-pool opt-in unchanged (absent
stays absent). **Dependency stated plainly: P8's vendor probes are UNRUN**
(docs/PARKED_AND_LIMITATIONS.md:37; W109 gap 3, docs/ledger/W109-...comple.md:65-72).
Whether api.deepseek.com/anthropic, api.z.ai/api/anthropic, api.moonshot.ai/anthropic
accept Messages-schema `cache_control` is unknown; a rejecting endpoint turns the
opt-in into per-request 400s. The opt-in stays documented as dark until per-vendor
probes land — probe-gated, never date-gated. So C is implementable and pinnable offline
but NOT production-enablable until P8 lands.

Also stated plainly: markers-only realizes only the STATIC-HEAD slice (system block +
last tool definition, `src/integrations/model-profile.ts:228-248`). The growing
conversation — the dominant token mass — stays uncached until P13's per-turn boundary
policy is decided (docs/PARKED_AND_LIMITATIONS.md:42). C's ceiling is partial by
construction.

### D — The Messages-schema replay integrity check (the successor decision the record names)

Not a transform: a fail-closed REJECT tier on the messages lane for malformed replays
(tool_use blocks unattributed to tool_results; thinking-signature replay integrity) —
the exact shape W123 queues as the successor decision
(docs/ledger/W123-...extraction-s.md:21-24; `src/integrations/model-usage-proxy.ts:496-500`).
It changes the lane's posture from replay-ungated to enforced, and its primary
compatibility risk is the W070b sanctioned path itself: the `route-anthropic`
synthetic insertions ARE this lane's traffic, so a reject tier must not break the
insertions the replay policy routes here (`src/integrations/model-replay-policy.ts:70-75`;
the existing detector `detectSyntheticToolCallTurns` at `:194-233` is
chat-completions-shaped — the messages-lane sibling needs its own detection).

---

## 3. Per-option analysis

| Option | Metering delta over the W123 floor | Security / blast radius | Compatibility surface | Verification (offline pin vs LIVE probe) | Cost |
|---|---|---|---|---|---|
| A hold | none (the floor) | zero request-side mutation | none (the W123 record stands) | already pinned (`test/model-usage-proxy.test.ts:551-558`) | zero |
| A′ labels | model labels in the trail | parse-only, still no mutation | none | offline pin | small |
| B shape | shaping's token effects observable; WARN-tier downgrade becomes effective on the lane | request REWRITER on a 2nd lane; fail-open protects availability, not correctness | replay policy (unchanged), W118 semantics + W109 ordering, host-adapter body shapes | pins offline; LIVE shape probes (GLM/Kimi wiring + deepseek acceptance) operator-gated | moderate |
| C markers | nonzero cacheRead/cacheCreate WHEN markers are honored (P12 fields, no metering work) | smallest mutation: additive markers on stable prefixes; risk = unprobed endpoint 400s | Messages schema requires markers (Anthropic-the-vendor); 3 compat endpoints unprobed (P8) | pins offline; LIVE = P8's probes themselves + a post-probe effectiveness read | small code + probe run |
| D integrity | none (rejections are a correctness control) | fail-closed: the blast radius is FALSE REJECTIONS on the sanctioned path | the W070b sanctioned synthetic path is the primary surface; host-composed Messages bodies | detector pins offline; LIVE host-body audit + host-adapter probes before reject goes live | moderate |

### 3.1 Metering (the W123 extraction is the floor)

The floor for every option: real tokens on the lane (prompt side = `input_tokens` +
`cache_creation_input_tokens` + `cache_read_input_tokens`; completion = `output_tokens`),
one usage event per message on both the JSON and SSE lanes, cache components
first-class (P12), raw fields riding `onUsage`, `costUsd` 0 on the lane (no cost field
in the anthropic shape, bounded server-side by the OpenRouter per-key credit limit —
`src/integrations/model-usage-proxy.ts:490-493`). **No option in this brief changes
the cost boundary** — that is a usage-shape/pricing-table question outside transform
governance, and the record does not queue it here.

- A: the floor, unchanged. A′ adds request-side model labels (usageEvents semantics
  unchanged).
- B: the floor, plus the ability to OBSERVE shaping's token effects (a verified
  thinking shape's output-mass delta becomes measurable because the trail is honest).
  The WARN-tier downgrade becomes effective on messages-lane sessions (its activation
  reads the proxy's own recorded usage, which includes the lane since W123 —
  `src/integrations/model-usage-proxy.ts:240-261`).
- C: the floor, plus nonzero `cacheReadTokens`/`cacheCreateTokens` when markers are
  honored (P8-gated). Savings become observable in the existing P12 fields — no
  metering work needed.
- D: no metering delta.

### 3.2 Security / blast radius (transforming provider-bound payloads)

- A/A′: zero request-side mutation; the payload is byte-faithful end to end. Residuals
  stay as recorded: wire invariants unenforced on the lane; malformed bodies unchecked.
- B: the proxy becomes a request REWRITER on a second lane. The composition's fail-open
  protects availability (a throwing stage is skipped,
  `src/integrations/model-usage-proxy.ts:47-56`) but NOT correctness (a stage returning
  a wrong-but-record body forwards — nothing validates semantic shape). The
  chat-completions lane already carries this accepted risk; B doubles the mutation
  surface. Mitigation inherent in the design: a mis-shape cannot corrupt the TRAIL
  (W123's type-keyed extraction is response-side), only the request. B also GAINS a
  control: the W070a wire invariant enforced at this boundary.
- C: the smallest request-side mutation — additive `cache_control` markers on stable
  prefixes, absent-never-fabricated, pre-existing markers preserved, never mutating
  (`src/integrations/model-profile.ts:211-247`). Risk concentrates in the UNPROBED
  endpoint acceptance (per-request 400s on a rejecting endpoint) — exactly why the
  record gates it on P8.
- D: fail-closed by design; the blast radius is false rejections on the sanctioned
  synthetic path (the K3 400 pattern generalized to the messages lane) — so it needs
  the strongest compatibility evidence before going live.

### 3.3 Compatibility surface (the replay policy, the host adapters)

- A/A′: no surface moves; the W123 compatibility record (replay-ungated messages lane)
  stands as-is. Host adapters unaffected — the lane's contract is pass-through.
- B: the replay policy stays chat-completions-scoped unless D also lands; the W118
  downgrade semantics carry over with two conditions (the downgraded-TO target must be
  valid on the messages wire; the Auto Router skip keyed on `isAutoRouterModel`
  carries over); the W109 ordering guidance (downgrade before shaping,
  `src/integrations/model-usage-proxy.ts:32-41`) applies unchanged. Host adapters: what
  OpenCode/goose/Cline compose when pointed at anthropic-compatible baseUrls is the
  live probe question. Responses are untouched in every option — only request bodies
  are in scope, so adapter response handling is out of blast radius.
- C: the Messages SCHEMA requires markers (Anthropic-the-vendor); the three compat
  endpoints' acceptance is unprobed (P8). The system-string→block-array rewrite
  (`src/integrations/model-profile.ts:232-233`) is a schema-shape change on a body the
  HOST composed — schema-valid on the anthropic wire but visible to the vendor.
  DeepSeek's sanctioned synthetic insertions would ride marked prefixes (markers sit on
  system/tools, not on the per-turn message lane — safe relative to that path).
- D: the W070b sanctioned synthetic-tool-call path is the PRIMARY compat surface — the
  reject tier must tolerate the insertion patterns the replay policy itself routes to
  this lane, or the policy contradicts itself.

### 3.4 Verification plan (what can be pinned vs what needs LIVE probes — operator-gated)

- A: already pinned — the pass-through pin asserts the body forwards untouched with no
  `usage.include` (`test/model-usage-proxy.test.ts:551-558`); the W123 metering pins
  (19/19 + 23/23 at landing; 52/52 focused after the P12-era extension,
  docs/ledger/W109-...comple.md:158-159) hold the trail. Optional A′ pin: parse-only
  capture, body unchanged, label recorded. No live probes.
- B: offline pins for a messages-scoped chain (shaping keyed on the lane,
  downgrade-before-shaping ordering, the malformed posture, the GLM/Kimi scrub, the
  W070b invariant). LIVE (operator-gated): the GLM/Kimi anthropic-wire shape probes
  (wiring the verified shapes — the queued W109 round-1 P1 follow-up) and a deepseek
  `reasoning` acceptance probe; NOT covered by P8's scope (P8 is cache_control
  acceptance) but the same probe-harness pattern as `docs/HOST_ADAPTERS.md`.
- C: offline pins for the marker stage on messages bodies (opt-in, wire-gated, static
  head, never-mutating). LIVE: P8's probes themselves — the gate for ANY production
  opt-in; after they land, an effectiveness read (nonzero cacheRead mass in the P12
  fields on marked traffic) — the c2 end-to-end effectiveness the W109 item queued.
- D: offline pins for the pure detector. LIVE: a host-body audit (what Messages bodies
  the real hosts compose, the W070b sanctioned path included) plus host-adapter probes
  BEFORE any reject tier goes live — rejecting a legitimate host pattern would be the
  failure mode.

### 3.5 Cost

- A: zero code (A′: small — one parse-only capture point + a pin).
- C: small code (a lane branch that parses + one marker stage reusing
  `applyCacheMarkers` verbatim) + the P8 probe run (operator-gated, external).
- B: moderate code (lane discriminator, messages-scoped composition with ordering,
  malformed posture) + shape probes + pins; the GLM/Kimi verified-shape wiring is
  queued design work on top.
- D: moderate code (a new pure detector + a reject tier) + a host-body audit + pins;
  the largest compatibility-surface work of the four.

---

## 4. Recommendation and trade-offs

**Recommendation (input only — the DECISION stays the operator's):** hold the
pass-through stance (A) as the standing posture, and treat the unrun P8 probes as the
gate that decides when the stance is re-opened — not an indefinite hold. The record
supports this sequencing: run P8's vendor probes first (they gate C outright and
de-risk B's shape questions); then C (markers-only) as the smallest first mutation IF
the probes accept; B deferred until the GLM/Kimi shape probes land, and only if
pass-through is observed to be actively harmful; D pursued on its own axis as the
record's queued successor decision (it does not depend on A/B/C).

**The core trade-off:** A preserves byte-faithful payloads and costs nothing, but the
reasons the lane was left untransformed (the polluted trail, the unrecorded usage
shape, the missing compatibility record) have all been resolved by W123+P12 — the hold
is now justified only by the PROBE gaps (P8; the GLM/Kimi shapes), and every session
that lives on the lane keeps paying the standing costs: no cache savings, an inert
WARN-tier downgrade, unenforced wire invariants, and no model labels. The stance that
was once forced by missing records is now a choice, and the cheapest path to resolving
it runs through operator-gated probes, not through new code.

- Why not B now: the largest mutation on the lane; its production gate (verified vendor
  shapes) is unrun; its metering payoff over C is speculative until a shape is verified
  to change anything.
- Why not C now: implementable and pinnable today, but production opt-in would violate
  the record's own probe-gated-never-date-gated rule (W109 gap 3) — shipping it dark
  converts a cache optimization into a per-request 400 generator on a rejecting
  endpoint.
- Why not D first: record-supported and orthogonal, but its blast radius (false
  rejections on the sanctioned path) makes it the wrong FIRST mutation on a lane that
  has never had one.

The DECISION stays the operator's.

---

## 5. Implementation sketches (so the decision is executable)

### A (hold)

1. No code. Optionally A′: in `handle`, a lane branch for `POST /v1/messages` that
   JSON-parses into a THROWAWAY record (never reassigns `outboundBody`), records
   `model` into the metrics/trail, and on parse failure increments a malformed-body
   counter instead of 400ing.
2. Pin: the capture mutates nothing (the upstream body deep-equals the inbound bytes)
   and the trail gains the model label.

### C (markers-only)

1. Lane discriminator: `isMessages = req.method === "POST" && /\/v1\/messages$/.test(req.url ?? "")`
   alongside `isCompletions` (`src/integrations/model-usage-proxy.ts:302`).
2. On the messages branch: parse; decide the malformed posture EXPLICITLY (400 like
   chat-completions, or fail-open skip marking while still forwarding — the
   chat-completions precedent is the 400); locate the pool profile by `body.model`
   against the same wire-threaded profiles map
   (`src/integrations/open-model-proxy.ts:102-122`); apply a marker stage that reuses
   `applyCacheMarkers` verbatim (it already gates on
   `profile.cacheMarkers === true && profile.wire === "anthropic"`,
   `src/integrations/model-profile.ts:229`).
3. Do NOT port the `usage.include` injection — the messages wire always reports usage
   (`test/model-usage-proxy.test.ts:551-552`).
4. Compose via `composeBodyTransforms` with the same per-stage fail-open semantics;
   keep the downgrade stage OUT unless B is also chosen.
5. Pins: opt-in absent → untouched; system string→block and last tool def marked;
   pre-existing markers preserved; the malformed posture.
6. Production gate: P8's probes per vendor endpoint; the opt-in stays dark until
   probed (the record's rule, docs/ledger/W109-...comple.md:70-72).

### B (shape)

1. Steps 1-2 of C for the branch, then compose the messages-scoped chain as
   `[downgradeStage, shapeStage]` — downgrade BEFORE shaping (the W109 ordering
   guidance, `src/integrations/model-usage-proxy.ts:32-41`); the existing
   `downgradeStage` (`src/integrations/model-usage-proxy.ts:254-261`) works as-is if
   the downgraded-TO target is valid on the messages wire; the Auto Router skip
   (`isAutoRouterModel`) carries over.
2. The shape stage keys on `body.model` against the same profiles map and calls
   `shapeRequestBody` — the anthropic-wire branches exist
   (`src/integrations/model-profile.ts:144-169`); GLM/Kimi arrive as scrubs until
   their verified shapes are wired (the queued round-1 P1 follow-up).
3. Decide the malformed posture (as in C).
4. Pins: downgrade-before-shaping on the lane; GLM/Kimi scrub (no invented fields);
   deepseek `reasoning.effort` shape; the W070b invariant (no
   `thinking.type: "disabled"` on any wire).
5. Production gate: the GLM/Kimi + deepseek anthropic-wire shape probes (live,
   operator-gated).

### D (replay integrity)

1. New pure module in `src/integrations/` (sibling to
   `src/integrations/model-replay-policy.ts` — pure functions, no IO):
   `detectMessagesSchemaReplayViolations(messages)` — tool_use/tool_result attribution
   (the messages-lane sibling of `detectSyntheticToolCallTurns`,
   `src/integrations/model-replay-policy.ts:194-233`) and thinking-signature replay
   integrity per the vendor's preserved-thinking requirement.
2. Enforce at the messages branch — or, more conservatively, an advisory-only first
   cut (observe, never reject) upgraded to reject only after the host-body audit.
3. Prerequisite: the host-body audit — enumerate what Messages bodies the real hosts
   compose (OpenCode/goose/Cline pointed at anthropic-compatible baseUrls, plus the
   W070b sanctioned insertions) so a reject tier cannot fire on legitimate traffic.
4. Pins for the detector; LIVE host-adapter probes before reject goes live.

---

## 6. Explicitly not done here

- No code changed (docs-only brief; lint + typecheck run as sanity only).
- No policy decided: the lane stays untransformed as recorded
  (docs/PARKED_AND_LIMITATIONS.md:38) until the operator decides; this brief does not
  move the P8, P13, or D-axis records.
- Issue #288 stays OPEN with the decision queued; the commit refs it.
