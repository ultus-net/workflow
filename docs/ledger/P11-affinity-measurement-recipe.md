<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) - this is the record of the P11 turnkey affinity-MEASUREMENT RECIPE landing, not a landed live measurement. Write-once: append dated supersession notes, never rewrite. Park P11 and issue #290 stay OPEN - the live run is the operator's. -->

### P11r - the operator's turnkey affinity-measurement recipe (Complete - the recipe itself; the live per-pool cache-hit verdicts remain operator-gated/unrun) (issue #290 P11; docs-only, no production change) (2026-09-30)

**Source:** P11 (`docs/PARKED_AND_LIMITATIONS.md:40`) and issue #290, after the
landed affinity spec (`docs/AFFINITY_ROUTING_SPEC_2026-09-24.md`,
frontier-verified through round 3) and the landed P12 cached-token fields
(2026-09-27, PR #311). The spec carried the measurement pair (its §8 item 5),
the metering-trail argument (§6), and the cost tradeoff (§5) but no
operator-facing run sequence; this fragment records collapsing it into one
runbook so the live cache-hit measurement is turnkey: the prerequisites, the
provider-side fields, the matched-pair method, the honest caveat, the
recording template, and the watch items in one place. Mirrors the P8 / P5
recipe shapes (`docs/P8_LIVE_RUN_RECIPE.md`, `docs/P5_LIVE_RUN_RECIPE.md`).

**What landed (docs only):**

1. `docs/P11_AFFINITY_MEASUREMENT_RECIPE.md` - the operator runbook. It
   carries:
   - **The prerequisites**: P19's affinity pin (NOT started), P12's fields
     (LANDED 2026-09-27), an opted-in long-session pool, and the live
     credential; it reuses the P5 credential/gate resolution rather than
     adding a new gate token;
   - **The provider-side observability**: the anthropic wire fields
     `cache_creation_input_tokens` / `cache_read_input_tokens`, surfaced in
     Workflow as `cacheCreateTokens` / `cacheReadTokens` through the proxy
     metrics (`model-usage-proxy.ts:96-97`, `:642-654`, `:760-767`), the
     per-run summary (`run-registry.ts:65-66`), the hub `/snapshot` usage block
     (`hub-snapshot.ts:37`), and the timeline row (`activity-timeline.ts:147-148`);
   - **The comparison method**: a matched pair (same pool/model/prefix, pin
     OFF vs ON), two turns each, reading the turn-2 `cacheReadTokens` (the
     first request can only show creation);
   - **The honest caveat**: structural verification only until the live run -
     the spec proves the RECORDING mechanics unaffected, not a hit or a saving;
     P12's field existence is met but the EFFECT is not, and savings stay
     `unmeasured`;
   - **The verdict-record template**: per-pool rows (no `PROBE_VERDICTS.json`
     row - P11, like P5, is not a gated probe file) with the
     green/negative/blocked mapping and the rule that a partial run never
     widens a green to unmeasured pools;
   - **The watch items**: the W109 prefix-policy gap (affinity without the
     per-turn boundary policy saves the static prefix only; P13 governs the
     growing mass), P19's open pin semantics (per-role vs per-session;
     restart/alias drift), and the resolver's fail-open to no injection.
2. The P11 row (`docs/PARKED_AND_LIMITATIONS.md:40`) gained the dated
   measurement-recipe note and the `docs/P11_AFFINITY_MEASUREMENT_RECIPE.md` /
   this fragment pointers; the row's verification status stays `Unmeasured`.

**Evidence:**

- Docs-only: `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped);
  state not applicable (no code path).

**Boundaries (remain):** the live per-pool verdicts are UNRUN - the operator's
run is what produces them, and it cannot run before P19 lands. No savings claim
is earned by this recipe; the W109 per-turn boundary policy (P13) is a separate
governor and the recipe claims only the static-prefix delta. P11 / issue #290
stays OPEN; the affinity implementation (P19) stays parked. No production
change; no live call is made by this recipe.
