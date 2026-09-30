<!-- Ledger fragment: the P13 option-B implementation record (issue #292). Write-once — append dated supersession notes, never rewrite. The activation stays dark behind the unrun P8 vendor probes and the queued P9 lane-governance decision; this fragment records only the offline code + pins. -->

### P13b — the per-turn boundary marks (Landed — option B under the SAME dark opt-in as the markers-only path; the P8/P9 gates for live activation stand) (issue #292) (2026-09-30)

**Source:** `docs/P13_BREAKPOINT_POLICY_BRIEF.md` §2 B (the operator-approved
target; issue #292) and the P13 row (`docs/PARKED_AND_LIMITATIONS.md:42`,
operator-approved 2026-09-24; W109 gap 4, deferred as LOAD-BEARING). The
governance context is `docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md` §2 C. The
implementation extends the W109 marker pass (`src/integrations/model-profile.ts`)
on the same `cacheMarkers` opt-in surface the P9 markers-only path uses — no
new option, no default change.

**What landed:**

- **The per-turn boundary mark.** `applyCacheMarkers` now places ONE
  `cache_control: {type: "ephemeral"}` breakpoint on the END of the previous
  turn's last message (the final `messages` entry's final content block), in
  addition to the static head (system block + last tool). The next turn submits
  that same prefix plus new content, so the cache matches at the prior boundary
  and the growing conversation — the dominant token mass — becomes cache-READ.
  A pure exported helper `applyPerTurnBoundaryMark(messages)` performs the
  placement; it never mutates, preserves a pre-existing marker (never
  double-marked), rewrites a string content to a one-block text array (the same
  schema-shape change the system rewrite makes), and is positional (the last
  message regardless of role), so a W070b-synthetic inserted tail is tolerated.
- **The breakpoint-budget discipline, documented and pinned.** The anthropic
  wire allows a small number of breakpoints per request. Option B spends
  EXACTLY ONE on the conversation (`PER_TURN_BOUNDARY_BREAKPOINTS = 1`), holding
  only the latest stable boundary re-derived each turn — never many prior turn
  ends. Static head (2) + one boundary = at most three marked ends, inside the
  wire's few-breakpoint budget. The rationale is on the exported constant and in
  the `applyCacheMarkers` doc comment; the pins assert exactly one conversation
  breakpoint (prior turns carry none) and the 3-end total.
- **DEFAULT byte-unchanged / fail-closed dark.** With no opt-in (or the openai
  wire, or a family omitted from a P14 map) the pass returns the body untouched
  — no markers at all, the per-turn lane byte-identical. This is the same dark
  posture as markers-only: nothing fires until the operator enables the opt-in.
- **The vendor probe's frozen shape reflects the deployed request.** The
  P8 harness (`test/vendor-anthropic-cache-probe.test.ts`) composes its probe
  body through the production marker pass, so its `assertMarkerShape` now
  asserts the boundary marker on the last message's final block (was: "no marker
  on the messages lane") — the stale as-found assertion would otherwise have
  silently stopped discriminating.

**Evidence:** red-first pins captured verbatim against unmodified src, then
green after implementation.

- Verbatim reds (the per-turn boundary was not yet marked; the pass left the
  `messages` lane untouched):
  - `test/model-profile.test.ts` → 7 fail / 17 pass:
    `not ok 9 - W109: applyCacheMarkers marks the stable composition-time prefixes on the anthropic wire`;
    `not ok 12 - W109: the marker pass is opt-in and wire-gated — everything else passes through untouched`;
    `not ok 18 - P13: the opt-in marks the previous turn's end in addition to the static head`;
    `not ok 19 - P13: exactly ONE conversation breakpoint is spent (the wire's small budget)`;
    `not ok 20 - P13: a string-content last message is rewritten to a marked text block`;
    `not ok 21 - P13: a pre-existing boundary marker is preserved, never double-marked`;
    `not ok 23 - P13: a synthetic (host-inserted) final turn still receives the boundary on its last block`.
  - `test/open-model-proxy.test.ts` → 1 fail / 9 pass:
    `not ok 8 - P13: the opted-in anthropic-wire pool marks the previous turn's boundary on the wire`.
  - `test/vendor-anthropic-cache-probe.test.ts` → 2 fail / 2 pass / 4 skipped:
    `not ok 1 - vendor cache probe: the composed anthropic request carries the ephemeral markers on the stable prefixes`;
    `not ok 2 - vendor cache probe: the composed provider-lane request carries the same ephemeral markers`.
- Green pins:
  - `test/model-profile.test.ts`: boundary marked in addition to the static head
    (prior turns unmarked); exactly one conversation breakpoint (3-end total);
    string-content rewrite; pre-existing-marker preservation; no-messages /
    empty-array / dark-default / openai-wire all untouched; synthetic-tail
    tolerance.
  - `test/open-model-proxy.test.ts`: the boundary reaches the wire through the
    governed pipeline under the opt-in, and the lane passes through
    byte-unchanged without it.
  - Green counts: `test/model-profile.test.ts` → **24/24 pass, 0 fail**;
    `test/open-model-proxy.test.ts` → **10/10 pass, 0 fail**;
    `test/vendor-anthropic-cache-probe.test.ts` → **4/4 pass, 4 gated-skip, 0
    fail**; `test/model-usage-proxy.test.ts` → **23/23 pass, 0 fail**.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Residuals:** the LIVE payoff is unproven and stays gated — the marker opt-in
is dark until the operator-runnable P8 per-vendor/per-provider probes
(`test/vendor-anthropic-cache-probe.test.ts`) show the endpoint accepts
Messages-schema `cache_control`, and the P9 lane-governance decision must land
markers on the anthropic Messages lane at all. Whether the appended tokens are
actually read back needs a live effectiveness read (nonzero `cacheReadTokens`
growth on marked traffic, the P12 fields in
`src/integrations/model-usage-proxy.ts`). None of that is pinnable offline. The
static-head-only path remains available (the opt-in can stay off); the sliding
window (option C) is the recorded budget-safe fallback, not implemented here.
