# P13 — the message-lane breakpoint policy decision brief

**Issue:** #292 · **Date:** 2026-09-30 · **Kind:** DECISION INPUT (docs-only; no code, no policy change)

**Status:** decision INPUT only — **this brief is the input; the DECISION is the
operator's.** Nothing here authorizes a code change. · **Item:** parked P13
(docs/PARKED_AND_LIMITATIONS.md:42, operator-approved 2026-09-24). ·
**Sources read in full:** the P13 row (docs/PARKED_AND_LIMITATIONS.md:42); the
P8 row (docs/PARKED_AND_LIMITATIONS.md:37); the P9 row and the P9 governance
brief (docs/PARKED_AND_LIMITATIONS.md:38; docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md,
2026-09-30); the marker implementation (src/integrations/model-profile.ts:207-248;
src/integrations/open-model-proxy.ts:102-146); the replay policy
(src/integrations/model-replay-policy.ts); the metering seam
(src/integrations/model-usage-proxy.ts); the W109 ledger fragment
(docs/ledger/W109-the-transformbody-seam-bundle-w098-c2-w095-c2-w098-c4-comple.md);
the W123 ledger fragment
(docs/ledger/W123-the-anthropic-messages-lane-meters-honestly-the-extraction-s.md).

---

## 0. Scope: what this brief is, and what it is not

P13 is ONE sub-decision inside the marker pass: **where the prompt-cache
breakpoints sit on the growing conversation**. It is narrower than P9's
messages-lane governance decision (whether the lane is transformed at all) and
narrower than P8 (whether the anthropic-compatible vendors accept markers at
all). The three are chained: P8 gates whether markers fire at all; P9 gates
whether the messages lane is governed (markers can only reach that lane through
the P9 "markers-only" option); P13 assumes both and decides the boundary policy
*within* the marker pass. This brief decides none of the three.

The marker machinery is landed but fires only on the **chat-completions lane**
today (W109); on the anthropic Messages lane the markers are dark until P9's
decision lands them there (W109 gap 1, docs/ledger/W109-...comple.md:43-59;
P9 brief §1.3). So P13's options are *policy designs*, not yet live behaviors —
the brief is explicit about which parts are decidable offline now and which are
gated on the other two decisions.

---

## 1. The gap and what the minimal slice does

### 1.1 The record's own statement

Park P13 (docs/PARKED_AND_LIMITATIONS.md:42, dated 2026-09-24): "the anthropic
wire allows few breakpoints and caches only at marked prefix ends; the minimal
slice marks the static head only, so the growing conversation — the dominant
token mass — is never cache-read until the per-turn boundary policy is
decided." W109.s queued gap 4 states the substance (its word is "a small number"; "few" is the park row.s phrasing) and calls the deferral
**load-bearing** (docs/ledger/W109-...comple.md:73-78).

### 1.2 What the minimal slice does (static-head marking)

`applyCacheMarkers` (src/integrations/model-profile.ts:228-248) is opt-in per
pool (`profile.cacheMarkers === true`) and wire-gated to the anthropic Messages
wire (`profile.wire === "anthropic"`, `:229`). When it fires it marks exactly
two **static composition-time prefixes**:

- the **system block** — a string `system` is rewritten to a one-block text
  array carrying `cache_control: {type: "ephemeral"}` (`:232-233`); an
  array `system` marks only its LAST block, preserving any pre-existing marker
  (`:234-239`, via `withMarker`, `:211-214`);
- the **last tool definition** (`:240-246`).

Everything else passes through: the marker is additive, absent-never-fabricated,
never mutating (`:216-226`), and the **per-turn `messages` array is
deliberately untouched**. The source comment is explicit: "the per-turn message
lane is append-only and its boundary policy is deliberately NOT decided here"
(`:219-223`).

### 1.3 Why the growing conversation is never cache-read

On the anthropic wire a request is cache-READ only up to the last marked
prefix end that matches a previously written cache. Because the only marked
ends are the static head (system + tools), the cacheable prefix is fixed at the
head; the `messages` array — which grows every turn and carries the dominant
token mass — has no marked end, so it is never part of a cache match. The
result: on a long session, the tokens that matter most (the accumulated
conversation) are re-billed at full input rates every turn, while only the
relatively small static head rides the cache (P13 row, docs/PARKED_AND_LIMITATIONS.md:42).

### 1.4 The dependency facts that bound any answer

- **The lane is not governed yet (P9).** The marker pass fires on the
  chat-completions lane only; the anthropic Messages lane is raw-forwarded and
  untransformed by recorded decision (docs/PARKED_AND_LIMITATIONS.md:38; W109
  gap 1, docs/ledger/W109-...comple.md:43-59). Markers reach the message lane
  only through the P9 brief's **option C (markers-only)** (P9 brief §2 C,
  :164-179), which is itself gated (below). The P9 brief names P13 explicitly as
  the ceiling of that option: "markers-only realizes only the STATIC-HEAD slice
  … The growing conversation … stays uncached until P13's per-turn boundary
  policy is decided" (P9 brief :175-179).
- **The vendors are unprobed (P8).** Whether the anthropic-compatible endpoints
  accept Messages-schema `cache_control` is unknown
  (docs/PARKED_AND_LIMITATIONS.md:37; W109 gap 3, docs/ledger/W109-...comple.md:65-72;
  limitation L8, docs/PARKED_AND_LIMITATIONS.md:61). The three compat endpoints
  are wired as vendor facts (src/integrations/model-profile.ts:46-69:
  `api.deepseek.com/anthropic`, `api.z.ai/api/anthropic`,
  `api.moonshot.ai/anthropic`). A rejecting endpoint turns any opt-in into
  per-request 400s — so the opt-in stays dark until probed
  (probe-gated, never date-gated).
- **The trail can measure any choice (W123 + P12).** The anthropic usage shape
  is recorded and the extraction is honest (W123, 2026-09-24), and
  `cacheReadTokens` / `cacheCreateTokens` are first-class metrics
  (src/integrations/model-usage-proxy.ts:87-88, :134-135, :514-515; P12 landed
  2026-09-27, docs/PARKED_AND_LIMITATIONS.md:41;
  docs/ledger/W123-...extraction-s.md:86-94). Whatever the boundary policy,
  its effect is observable in those fields — **no metering work is a
  prerequisite of this decision.**

---

## 2. The options as the record implies

The options are boundary policies *within* the marker pass. Each is described
by: what becomes cacheable, the wire's few-breakpoint interaction, the metering
observability (P12 fields), the cost (extra marked tokens are written at
cache-create rates), the compatibility (the replay policy), and the
verification plan (offline pins vs operator-gated live traffic).

### A — static-head only (status quo)

**What becomes cacheable:** the system block and the last tool definition —
nothing else. The growing conversation is never read from cache
(docs/PARKED_AND_LIMITATIONS.md:42).

**Wire-limit interaction:** minimal — two marked ends, well under the wire's
few-breakpoint budget. The budget is not a constraint because nothing else is
marked.

**Metering:** `cacheReadTokens`/`cacheCreateTokens` register only the static
head's (small) mass; the P12 fields exist and would show it, but the dominant
conversation mass never appears as a cache read.

**Cost:** only the static head is written at cache-create rates (and only when
markers are enabled); the conversation is billed at full input rates every turn.

**Compatibility:** the replay policy is untouched — this is the recorded
state (W123, docs/ledger/W123-...extraction-s.md:21-24; `enforceReplayPolicy`
stays chat-completions-scoped, src/integrations/model-replay-policy.ts:245-272).

**Verification:** already structurally pinned (the marker pass pins at W109
landing; the pass-through pins hold). No live traffic is needed to keep A —
this is the floor.

### B — per-turn boundary marks

**Mechanism:** each turn, mark the END of the previous turn's last message —
i.e. place one `cache_control` breakpoint on the last content block of the
final `messages` entry the host sent last turn. The next turn submits that same
prefix plus new content, so the cache matches at the prior boundary and the
whole growing prefix is cache-READ.

**What becomes cacheable:** the system head + tools + **the entire conversation
prefix through the previous turn's end**. This is the option that reaches the
dominant token mass the P13 row names.

**Wire-limit interaction:** this is where the budget bites. One boundary
breakpoint is consumed by the conversation, alongside the static-head marks
(system + last tool). The wire allows few breakpoints, so B requires a policy
of *which single boundary to hold*; it cannot mark many prior turn ends at once.
The policy question B forces: the boundary must be the latest stable one (the
prior turn's end), re-derived each turn — a stale boundary wastes budget and
misses the append-only growth.

**Metering:** the P12 fields would show the conversation mass moving into
`cacheReadTokens` (reuse) with the newly appended tokens appearing in
`cacheCreateTokens` per turn — exactly the reuse-distance signal the boundary
policy is chosen to optimize. No new metering work.

**Cost:** each turn writes the newly appended tokens at cache-create rates (a
premium over plain input), betting that the next turn reads them back at
cache-read rates. The break-even is a function of reuse distance (how many turns
before compaction/rewrite); longer conversations amortize better, short
one-shot exchanges pay write premium without reuse.

**Compatibility:** the replay policy is unaffected in *kind* — markers are
additive, on message content blocks, schema-valid on the Messages wire — but B
sits on the messages lane, so it presupposes the P9 markers-only posture (P9
brief §2 C, :164-179). The W070b sanctioned synthetic-tool-call insertions
(`route-anthropic`, src/integrations/model-replay-policy.ts:70-75, :260-269)
ride the message lane, so B's boundary placement must tolerate synthetic
inserted turns rather than assume host-only history. The static-head system
string→block rewrite (src/integrations/model-profile.ts:232-233) is a
schema-shape change visible to the vendor; B adds the same kind of change on
message blocks.

**Verification:** the boundary-selection logic is a pure function and can be
pinned offline (boundary index determinism, append-only growth, synthetic-path
tolerance, never-mutating, budget count). **The payoff is only verifiable with
live traffic:** whether the appended tokens are actually read back requires the
operator-gated P8 vendor probes (acceptance) plus an effectiveness read
(nonzero `cacheReadTokens` growth on marked traffic — the c2 end-to-end
effectiveness W109 queued). None of that can be pinned offline.

### C — a sliding window

**Mechanism:** mark a bounded tail prefix rather than the whole prior
conversation — e.g. the last N message boundaries (or the last boundary a
bounded budget allows), discarding older marks. The newest prefix is reused at
one-turn distance; older conversation beyond the window is re-read at full price
unless its own cache entry is still alive.

**What becomes cacheable:** the system head + tools + **a bounded recent tail**
of the conversation. Mass older than the window is not cache-read by this
request.

**Wire-limit interaction:** the inverse of B by construction: the window is
sized so the breakpoint budget does not bite. C trades cache coverage for
budget safety.

**Metering:** the P12 fields show a *partial* conversation mass in
`cacheReadTokens`, bounded by the window — a smaller reuse than B but a smaller
write premium and no budget pressure.

**Cost:** each turn writes the newly appended tokens at cache-create rates, same
premium as B, but the cached region is bounded, so the write/reuse ratio is more
conservative; tokens that fall out of the window are full-price.

**Compatibility:** identical surface to B (messages-lane, additive, synthetic-path
tolerance, P9 dependency).

**Verification:** the window-sizing function pins offline; the live payoff read
is the same operator-gated P8 acceptance + effectiveness read as B.

### D — defer the policy behind P9 + P8

**Mechanism:** decide nothing about boundaries now; keep A as the standing
posture and re-open P13 only after P9's lane-governance decision and P8's vendor
probes land. This is the option the record's own dependency column implies
(docs/PARKED_AND_LIMITATIONS.md:42: "Dependencies: P9's lane governance; the
per-turn boundary policy decision (operator input recommended)").

**What becomes cacheable:** whatever A caches today — the static head. Nothing
changes until the gating decisions land.

**Wire-limit interaction:** none now.

**Metering:** unchanged.

**Cost:** zero. The standing cost every lane session keeps paying is the
uncached conversation mass (docs/PARKED_AND_LIMITATIONS.md:42).

**Compatibility:** unchanged.

**Verification:** none needed for D; the gating work (P8 probes, P9 decision)
is the verification path that makes B or C decidable.

---

## 3. Dependency order (what is decidable now vs gated)

The chain is strict and one-directional:

```text
P8 vendor probes (accept cache_control at all?)
        │
        ▼
P9 lane-governance decision (markers reach the messages lane?)
        │
        ▼
P13 boundary policy (where the marks sit on the conversation)
```

- **P8 gates everything.** If the three compat endpoints reject Messages-schema
  `cache_control`, every marker option (A, B, C) is moot on those endpoints —
  the opt-in stays dark (probe-gated, never date-gated). P8 is a live,
  operator-gated probe run (docs/PARKED_AND_LIMITATIONS.md:37).
- **P9 gates whether P13 is live.** Markers can reach the messages lane only
  through the P9 markers-only posture; until P9 changes the lane from
  pass-through, P13's options are designs, not behaviors (P9 brief §2 C,
  :164-179; §3.3 :262-267).
- **P13 is decidable as a POLICY now, but only offline.** The boundary-selection
  logic, the budget discipline, the synthetic-path tolerance, and the
  never-mutating/append-only invariants can be designed and pinned **without
  live traffic**. What cannot be decided offline is *whether the payoff is
  real* — that needs P8's probes plus a live effectiveness read.
- **What the operator can decide in this brief:** the intended boundary policy
  (B as target, C as conservative variant, A hold, or D defer) so that when P9
  and P8 land, the marker pass has a recorded boundary design rather than
  drifting. The decision does not enable code; it fixes the policy the eventual
  implementation must satisfy.

---

## 4. Recommendation and trade-offs

**Recommendation (input only — the DECISION stays the operator's):** record
**B (per-turn boundary marks) as the intended target**, with **C (a bounded
sliding window) as its budget-safe variant**, and keep **A as the standing
posture until P9's decision and P8's probes land (D's sequencing)**. The
reasoning: the P13 row's whole point is that the growing conversation is the
dominant token mass (docs/PARKED_AND_LIMITATIONS.md:42); only B reaches it, and
its one-turn reuse distance is the best the wire's few-breakpoint budget can
buy. C is the honest fallback if the live reuse observed after P8 shows the
window cannot be disciplined within budget. A is not a solution to the gap, it
is the floor; D is not a policy, it is the correct *timing* for deciding one.

**The core trade-off:** B caches the dominant conversation mass (the point of
the exercise) at the price of a per-turn write premium on newly appended tokens
and a real breakpoint-budget/placement policy that must tolerate the W070b
synthetic path — and it remains unproven until live traffic shows the appended
tokens are actually read back. A costs nothing and mutates least, but leaves the
dominant mass permanently uncached. C sits between them: bounded coverage,
bounded premium, no budget pressure, smaller reuse.

- Why not ship B now: it is gated by P9 (the lane is not governed) and P8 (the
  vendors are unprobed); shipping a boundary policy live before those land would
  violate the probe-gated-never-date-gated rule and risk per-request 400s.
- Why not default to C now: C is budget-safe but caps the payoff; the record's
  stated gap is the dominant mass, and a bounded window may not reach it. C is
  the fallback, not the target.
- Why not make A permanent: A is the floor the record calls insufficient for
  the dominant token mass; the deferral was recorded as load-bearing precisely
  so it is not mistaken for an answer (docs/ledger/W109-...comple.md:73-78).

The DECISION stays the operator's.

---

## 5. Implementation sketch (so the decision is executable when its gates land)

The brief implements nothing; this sketch fixes the *shape* the eventual
implementation must have.

1. Marker stage extension: a pure boundary-selection function alongside
   `applyCacheMarkers` (src/integrations/model-profile.ts:207-248) that,
   given the `messages` array, returns the index of the prior-turn boundary to
   mark (B) or the bounded tail set (C). Never mutating, absent-never-fabricated,
   budget-capped, and tolerant of synthetic inserted turns.
2. Ordering: the boundary marks compose with the static-head marks through the
   existing ordered, per-stage fail-open seam (`composeBodyTransforms`,
   src/integrations/model-usage-proxy.ts:42-61) — markers stay a marker stage,
   not a rewriting stage.
3. Lane reach: the stage only fires on the messages lane once P9's markers-only
   posture governs it (P9 brief §5 C, :353-372).
4. Pins (offline now, once code is authorized): boundary-index determinism,
   append-only growth, budget count, synthetic-path tolerance, never-mutating,
   opt-in/wire-gated.
5. Production gate (operator): P8's per-vendor probes; then a live
   effectiveness read — nonzero `cacheReadTokens` growth on marked conversation
   traffic in the P12 fields (src/integrations/model-usage-proxy.ts:514-515).

---

## 6. Explicitly not done here

- No code changed (docs-only brief; there is no executable surface, so
  `npm run lint` / `npm run typecheck` are **not applicable** to this change —
  no such claim is made).
- No policy decided: the lane stays untransformed and the marker boundary stays
  static-head-only as recorded (docs/PARKED_AND_LIMITATIONS.md:42) until the
  operator decides; this brief does not move the P8, P9, or P13 records.
- Issue #292 stays OPEN with the decision queued; the commit refs it.
