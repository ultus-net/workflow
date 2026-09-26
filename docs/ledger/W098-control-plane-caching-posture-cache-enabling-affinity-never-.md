<!-- Ledger fragment: extracted from TASKS.md at line 2402 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W098 - Control-plane caching posture: cache-enabling + affinity, never response-caching (Partial - c1 audit/c2 markers/c3 spec/c4 frontier landed; the affinity implementation parked as P19) (2026-09-23)

**Operator question:** "should we be doing caching on the control
plane/router as well? This would complement the provider-side caching done
at OpenRouter's end."

**Position (recorded, design queued):**
- **Yes - but the control plane's caching role is cache-ENABLING, not
  response-caching.** Provider-side prompt caches reward STABLE prefixes;
  the hub composes the largest prefixes (system prompts, fleet guidance,
  tool definitions, per-role model config), so its discipline decides hit
  rates: (a) cache-aware composition - stable per-session prefixes,
  append-only per-turn content, stable tool-list serialization; (b) a
  cache-bust audit of everything the hub prepends per turn (the W073
  orientation/advisory guidance is the first thing to check); (c)
  cache-control marker injection at the transformBody seam for
  anthropic-wire pools (Anthropic requires explicit markers; OpenAI-family
  auto-caches) - a concrete, small complement OpenRouter cannot do
  per-workspace.
- **Model affinity as a routing key modifier**: pin consecutive turns of a
  session to the same vendor/model so provider-side prefix caches actually
  hit - Auto Router may bounce providers per request, losing cache state.
  Cost tradeoff recorded: affinity gives up per-request optimization for
  cache-hit savings; for long sessions with large stable prefixes the
  cache wins. This is a modifier on the W095 role key (narrow the pool,
  don't add a fifth key).
- **Deterministic-resource caching with TTL (already exists, the model to
  follow)**: the OpenRouter catalog cache in openrouter-auto-latest.ts
  (6h success / 60s failure backoff) - cache deterministic, versioned
  resources; never agentic turns.
- **Response caching is REJECTED**: agentic turns are nondeterministic and
  state-dependent (a cached response is by definition not fresh
  observation - the kernel's fresh-evidence rule), and serving from cache
  would corrupt the metering trail (recorded usage is the budget/billing
  evidence; phantom-free turns break its truthfulness). Same four-home
  logic as W095.

**Acceptance criteria:**
- [x] A cache-bust audit of hub-composed prefixes (orientation/guidance,
      system prompts, tool serialization) - before any affinity work.
      AUDIT SCOPE CORRECTION (W109 frontier round 1, 2026-09-23): the
      audit must extend into HOST-COMPOSED prefixes — on the default
      surface the system prompt and tool serialization are composed by
      OpenCode, not the hub (the environment block, compaction rewrites,
      mid-session tool churn are host-side); the hub composes the
      orientation block, per-turn advisory guidance, MCP mounts, and the
      loop prefix. Also (Anthropic-vendor conflation correction): the
      Messages SCHEMA requires explicit markers; whether the three
      anthropic-compatible endpoints (deepseek/glm/kimi) accept them is
      UNPROBED — the opt-in stays dark until per-vendor probes land.
      PART 1 LANDED (2026-09-24, feat/w098-proposal-prompt-cache-order):
      the loop-prefix slice — the default RSI proposal prompt reordered to
      stable preamble -> append-only history -> changing counters (the
      per-iteration counters previously rendered BEFORE the history,
      busting the provider prefix cache right before the bulk of every
      proposal turn); the W098 ordering pin freezes the invariant.
      Honest scope: verified structurally (the ordering pin +
      formatHistory's append-only serialization); the provider cache-hit
      improvement is NOT yet measured on live traffic.
      PART 2 LANDED — THE HUB-COMPOSED AUDIT (2026-09-24,
      test/w098-c1-guidance-audit; pins + ledger only, zero src change).
      Findings per site: (1) orientation block — static, versioned,
      zero-interpolation by construction (prompt-guidance.ts:69-86), the
      content snapshot + no-placeholder + order + opt-out pins already
      freeze it, and it renders as expected (g5-observability.test.ts:90-133); (2) per-turn advisory
      guidance — env-derived constants composed ONCE at hub startup
      (hub.ts:159), constant per process; (3) scheduler composition —
      guidance prepended, per-turn schedule prompt after
      (hub-scheduler.ts:358), the verbatim prefix order already pinned
      (hub-scheduler.test.ts:191) and the composed prompt is the recorded
      ask (the W041 digest binds it); (4) the reviewer rubric — stable
      five-axis preamble -> per-run content (task, manifest, diff) ->
      verdict instructions (rubric.ts:32-93); the section order was
      UNPINNED — the new decision-freezer pin freezes it (green on first
      run, the characterization-pin discipline); fresh session per run,
      so cross-run prefix affinity does not apply; (5) the RSI apply
      prompt (self-improvement-agent.ts:139-148) — static preamble leads,
      per-candidate fields follow, no append-only history to invert, fresh
      session per apply turn — stable, unpin-worthy beyond part 1's
      proposal-pin pattern; (6) the iteration-21
      reasoning-claim findings — observability-only, never injected into
      prompts (hub.ts:276-281). MCP-mount tool serialization and the
      host-composed prefixes (the OpenCode environment block, compaction
      rewrites, mid-session tool churn) are OUTSIDE hub control —
      DISPOSITIONED as host-side, not audited: the hub cannot pin what it
      does not compose, and that segment's cache behavior remains
      unmeasured. Criterion complete for the hub-composed surface: stable
      by construction; the affinity work (c3) is unblocked.
- [x] Cache-control marker injection at transformBody for anthropic-wire
      pools (opt-in per pool via model-profile.ts). LANDED in W109
      (machinery + pins, wire-gated, absent-never-fabricated) — with the
      two-sided honest scope: real-traffic effectiveness is queued on the
      messages-lane transform+metering governance gap (pre-existing) and
      the vendor probes; see the W109 item's queued list.
- [x] Affinity routing specced as a W095 key-1 modifier (pool narrowing),
      with the cost tradeoff recorded and the metering trail verified
      unaffected. LANDED (2026-09-24, PR this branch):
      docs/AFFINITY_ROUTING_SPEC_2026-09-24.md — frontier-verified in
      three rounds (Kimi K3: round 1 REVISE with 3×P1 — the
      family-granularity narrowing does NOT stop the bounce (the pin
      narrows to ONE SLUG); the role→model map the spec first cited does
      NOT exist (the spec is explicitly CONDITIONAL on W095 key-1's
      landing); the W109 lane equation corrected — round 2 REVISE at the
      pointer layer (six stale cross-refs, one wrong work-item cite) —
      round 3 ACCEPT). The metering trail is verified unaffected scoped
      to the RECORDING mechanics (affinity composes at the autoLatest
      allowed_models injection, upstream of the usage event) with the
      content-variance caveat recorded (the W109 pollution class — the
      trail's per-vendor content varies; P12's fields land on the
      governed lane only). The cost tradeoff is recorded two-sided
      including the outage-persistence cost (key 4 unwired — a pinned
      vendor's degradation persists session-long). The savings remain
      unmeasured (park P11) until P12 + P9.
- [x] Frontier verification of the design (same pattern as #82/#85).
      RAN (W109, 2026-09-23): Kimi K3, fresh context, adversarial — round
      1 REVISE (2×P1: the synthetic-path pin + the unrecorded
      messages-lane blocker; the glm/kimi mis-shape; 4×P2: the deferred
      breakpoint, the throw-containment, the vendor-premise conflation,
      the cached-token metering blind spot) with all corrections
      incorporated; round 2 confirms. The full record is the W109 item.
