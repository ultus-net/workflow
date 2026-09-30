<!-- Ledger fragment: opened 2026-09-30 as the P15 part (b) record (issue #294). Write-once — append dated supersession notes, never rewrite. -->

### P15 (b) — per-family pool metrics (Landed - the additive per-family view over the pool's recorded usage; the cross-family aggregate, the abort tier's snapshot, byte-identical) (2026-09-30)

**Source:** `docs/PARKED_AND_LIMITATIONS.md` row P15, part (b) — "the per-family usage-granularity residual stands (the pool's metrics() is the cross-family aggregate, now wired into the abort tier)". The abort tier consumes that aggregate via the W119 composition: `composeSessionWithBudget` wires the guard's `usageSnapshot` as `aggregateUsage(proxy.metrics(), additionalUsage?.())`, and the open-source lane passes `() => openPool.metrics()` (`src/integrations/acp-runtime.ts:199`, `:411`). GitHub issue #294. Parts (a) and (c) are out of scope ((a) landed on `feat/p15a-downgrade`; (c) is the design-open warn-threshold source decision).

**What landed:**

- **`OpenModelMeteringPool.perFamilyMetrics(): ReadonlyMap<ModelFamily, ModelUsageMetrics>`** (`src/integrations/open-model-proxy.ts`): one entry per family with a composed vendor proxy, each the family proxy's OWN recorded `metrics()` — the same per-entry records the aggregate sums. RECORDED-ONLY: the split is read from the proxies, never re-derived from a request log or the wire.
- **The aggregate is unchanged.** `metrics()` keeps the exact pre-change arithmetic, iteration order, and `latestPromptTokens` (last-defined-wins) semantics; both views now read ONE shared recorded snapshot (`recordedByFamily()`), so the per-family entries sum to the aggregate by construction. The W119 abort-tier snapshot (and every other `metrics()` consumer: `acp-runtime.ts` usage/`metrics` accessors, the `--metrics` debug prints (note: the `opencode-server-runtime.ts` proxy reports its OWN `proxy.metrics()`, a separate instance — the pool consumers are the aggregate readers)) is byte-identical.
- **A family with no resolved key carries no proxy and is absent from the view** (recorded-only: no records, no entry).
- **`docs/PARKED_AND_LIMITATIONS.md` row P15** got the dated append-only note recording (b) landed, (c) queued.

**Evidence:** red-first pins captured verbatim against unmodified src (`pool.perFamilyMetrics is not a function`: open-model-proxy 2 red, session-budget 1 red), then green after implementation.

- `test/open-model-proxy.test.ts` (P15 (b) pins): per-family attribution of tokens/cost across two families; each entry deep-equal to the family proxy's `metrics()`; the aggregate pinned byte-for-byte across every field and again after reading the view; the per-family shape carries the full `ModelUsageMetrics` (no field removed); a keyless family is absent.
- `test/session-budget.test.ts` (P15 (b) pin): the abort tier sees the cross-family AGGREGATE, not a per-family view — two families each under the cap (600/600) fire the abort at the summed 1200 through `() => pool.metrics()`.
- Green counts: `node --import tsx --test test/open-model-proxy.test.ts test/session-budget.test.ts test/open-source-pool.test.ts` → **32/32 pass, 0 fail**.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Residuals:** (c) the warn-threshold source decision remains queued (design-open). The OpenAI-lane cached-subset split (`prompt_tokens_details`) is the separately-queued refinement named on the `ModelUsageMetrics` cache fields (P12) — unchanged here.
