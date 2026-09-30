<!-- Ledger fragment: opened 2026-09-30 on branch feat/p15b-granularity as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### P15 part (b) — the per-family usage/cache-granularity residual — composition verification (Already landed on `origin/main`; the additive `perFamilyMetrics()` view + its pins are green as-found; NO code change was required on this branch) (2026-09-30)

**Source:** the recorded backlog row P15 remaining part (b) — "the per-family usage-granularity residual stands (the pool's `metrics()` is the cross-family aggregate, now wired into the abort tier)" — GitHub issue #294, dispatched as one executor subtask on branch `feat/p15b-granularity`, base `origin/main@a06139d2`.

**Decision: RECORD, not implement.** The per-family split already exists at the metering seam as an ADDITIVE view, so the canonical projection (`TaskUsageSummary`, `src/integrations/task-usage.ts:23-40`) is untouched and no dependency blocks it. The small-safe path is the one that shipped; this branch adds no production code and no test code — it verifies the landed pins green and records the discriminator.

**The landed implementation (`origin/main`, cited):**

- **`OpenModelMeteringPool.perFamilyMetrics(): ReadonlyMap<ModelFamily, ModelUsageMetrics>`** — interface at `src/integrations/open-model-proxy.ts:69-84`, implementation at `:208-242`: one entry per family with a composed vendor proxy, each the family proxy's OWN recorded `metrics()`. RECORDED-ONLY: the split is read from the proxies, never re-derived from a request log or the wire.
- **The aggregate is unchanged.** `metrics()` keeps its pre-change arithmetic, iteration order, and `latestPromptTokens` last-defined-wins semantics (`:217-239`); both views read ONE shared `recordedByFamily()` snapshot (`:212-213`), so the per-family entries sum to the aggregate by construction. The W119 abort-tier snapshot and every other `metrics()` consumer are byte-identical.
- **Cache granularity rides by construction.** Each entry is the full `ModelUsageMetrics`, including the P12 `cacheReadTokens`/`cacheCreateTokens` fields (`:80-102`); the shape assertion `test/open-model-proxy.test.ts:193-197` pins that the per-family view carries every field (no field removed). No per-family cache re-derivation exists at the projection seam, and none is added.
- **A family with no resolved key carries no proxy and is absent from the view** (recorded-only: no records, no entry; `test/open-model-proxy.test.ts:204-219`).
- **Landing lineage:** `71348452` (the P15 (b) commit), merge `bc7e374c` (PR #365 from `feat/p15b-family-metrics`), citation follow-up `ed3f2a1f`. The recorded landing ledger is `docs/ledger/P15b-per-family-metrics.md`.

**Why the projection contract is untouched (the task's discriminator):** per-family granularity could only "alter the canonical recorded shape" if it were surfaced by widening `TaskUsageSummary` or `RunUsageSummary`. The landed design does the opposite: it exposes a second read-only view at the metering seam and leaves the canonical boundary projection (`requests` / prompt / completion / total / cost, plus the P12 cache pair) exactly as-is. There is therefore no pending design and no dependency to record — the additive seam view was the small-safe fix and it shipped. The abort tier keeps consuming the cross-family aggregate (`test/session-budget.test.ts:292-302`: each family 600, the abort fires at the summed 1200 — the split is observability, not enforcement).

**Red-first capture (honest deviation): none on this branch.** The implementation and its pins predate this branch, so there was no red state to capture without reverting merged production behavior. The original landing captured the red verbatim against unmodified src (`pool.perFamilyMetrics is not a function`: open-model-proxy 2 red, session-budget 1 red — `docs/ledger/P15b-per-family-metrics.md:14`). Capturing a synthetic red here would require deleting merged behavior, which is out of scope and would be dishonest; this branch verifies the landed pins green.

**Evidence (this branch, base `origin/main@a06139d2`, working tree clean):**

- `node --import tsx --test test/open-model-proxy.test.ts test/session-budget.test.ts test/open-source-pool.test.ts` → **36/36 pass, 0 fail** (the landing-era count was 32/32; later P9 suites grew the focused files).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Deviation (recorded): the dispatch duplicated already-landed work.** Part (b) was recorded landed in the P15 row and `docs/ledger/P15b-per-family-metrics.md` before this branch was cut; this branch's tree is byte-identical to its base. No duplicate implementation was written. The value added here is the as-found verification and this record.

**Boundaries (unchanged):** (a) the auto-lane narrowing is landed (`docs/ledger/P15a-openrouter-downgrade.md`); (c) the warn-threshold source is decided option (a), the env axis (`docs/ledger/P15c-decision-recorded.md`). The OpenAI-lane cached-subset split (`prompt_tokens_details`) remains the separately-queued P12 refinement; the per-family view carries the cache fields, but the chat-completions lane reports them zero (the recorded lane asymmetry), so a nonzero per-family cache-attribution pin would require the anthropic Messages lane through the pool — a possible strengthening, not a contract gap.
