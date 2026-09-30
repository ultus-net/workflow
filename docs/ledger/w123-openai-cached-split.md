<!-- Ledger fragment: W123's queued cached-subset split for the OpenAI chat-completions lane (issue #290, 2026-09-30). Write-once landed record — append dated supersession notes, never rewrite. -->

### W123 (queued split) - The OpenAI chat-completions lane records prompt_tokens_details.cached_tokens as cacheReadTokens (2026-09-30)

**Source:** the `ModelUsageMetrics` docblock's recorded lane asymmetry
(`src/integrations/model-usage-proxy.ts`, the W123 normalization note): the
anthropic messages lane reports the cache components OUTSIDE `input_tokens`
(and `recordAnthropicUsage` records `cacheReadTokens`/`cacheCreateTokens`
first-class), while the OpenAI chat-completions lane reports cached reads
INSIDE `prompt_tokens` and "has no cache-create concept, so on that lane both
stay at their measured zero — the cached-subset split ... is a queued
refinement". Live evidence (2026-09-30): the deployed OpenAI-shaped lane
(OpenRouter chat-completions) served a real cache read
(`prompt_tokens_details.cached_tokens: 12032`) that the proxy recorded as 0/0,
so the P11 cache measurement could not see it through `proxy.metrics()`.

**What landed:** `recordUsage`'s OpenAI chat-completions branch now adds
`openAiCacheReadTokens(usage)` — an extractor for
`prompt_tokens_details.cached_tokens` (number, finite, `>= 0`) — to
`metrics.cacheReadTokens`. `promptTokens`/`totalTokens` are deliberately
UNCHANGED: on this lane the cached read is a SUBSET of `prompt_tokens`, so
re-summing it into the prompt side would double-count. The
`ModelUsageMetrics` docblock is amended in place to state the split is now
implemented while keeping the lane-asymmetry note; OpenAI has no cache-create
equivalent, so `cacheCreateTokens` stays at its measured zero on this lane.

**Double-count guard:** the extractor reads ONLY
`prompt_tokens_details.cached_tokens`. The anthropic-shaped
`cache_read_input_tokens` (and any bare top-level `cached_tokens`) is never
consulted on the OpenAI branch — the type-keyed anthropic detection
(`recordAnthropicUsage`) owns that shape, so a malformed payload carrying BOTH
shapes can only add the read once. Absent / non-record detail, or a
non-number / non-finite / negative `cached_tokens`, records a measured zero
(never NaN).

**Evidence (red/green + regression):**
- 3 new unit pins in `test/model-usage-proxy.test.ts`: the live shape
  (`cached_tokens: 12032`) yields `cacheReadTokens` = 12032 with
  `promptTokens` 20000 / `totalTokens` 20030 unchanged; absent / non-record /
  non-numeric / non-finite / negative detail yields a measured zero (never
  NaN); a payload carrying both the OpenAI detail and
  `cache_read_input_tokens` counts the read once (40, not 80).
- The pre-existing type-keyed hold-out ("a chat-completions usage with
  anthropic-style keys still records zeros") and the anthropic JSON/SSE pins
  stay green — the anthropic lane is unaffected (34/34 model-usage-proxy,
  previously 31/31).
- Focused consumer suites green: session-budget + open-model-proxy 30/30;
  usage-tracker + task-usage 12/12.
- `WORKFLOW_ACP_OPENCODE_METERED=1 node --import tsx --test
  test/acp-opencode-metered-probe.test.ts`: PASS (live, opencode v2 +
  OpenRouter). The live run now records `cacheReadTokens: 256` on the
  OpenAI-shaped lane where pre-change it was 0 — the deployed-lane cache read
  is visible through `proxy.metrics()`.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Out of scope:** the anthropic lane's own cache accounting is unchanged;
OpenAI cache-create remains unmeasured (no wire concept); the P11 cache
measurement consumer is unblocked here but lands separately.
