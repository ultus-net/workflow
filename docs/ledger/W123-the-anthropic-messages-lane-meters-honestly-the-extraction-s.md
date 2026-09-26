<!-- Ledger fragment: extracted from TASKS.md at line 4100 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W123 - The anthropic Messages lane meters honestly: the extraction's shape key corrected (P9 part 1 - the pollution closed; the transform-governance half stands) (2026-09-24)

**Source:** the operator-starred stream (P9 → P12 → P4, directed
2026-09-24); park P9's recorded nuance (the W109 review round-1
correction): the metering pipeline gates on /chat/completions — the
anthropic messages path passed through UNTRANSFORMED, and the
OpenAI-shaped extraction keyed `prompt_tokens`/`completion_tokens`
against the anthropic usage shape (`input_tokens`/`output_tokens`/
`cache_creation_input_tokens`/`cache_read_input_tokens`), so every
anthropic event landed as `usageEvents += 1` with ZERO tokens — the
budget tiers' input was polluted, not absent.

**The two prerequisite records the park entry demanded (recorded in
this change):** the anthropic usage shape (the non-stream message
response's `usage`; the stream splits it across message_start's
`message.usage` and message_delta's `usage`, CUMULATIVE — "not a
delta", summing double-counts; the recorded cautionary instance is
langchainjs #10249); the replay policy's Messages-schema compatibility
(`enforceReplayPolicy` stays chat-completions-scoped; the
anthropic-messages transport is W070b's sanctioned synthetic-tool-call
path and remains replay-ungated — the Messages-schema integrity check
is the queued successor decision).

**What landed:** the extraction keyed on the anthropic wire type
(`type: "message"` JSON; `message_start`/`message_delta` SSE) — the
type the chat-completions lane never carries, so no misclassification;
the cache components normalize INTO the prompt side (the cross-lane
normalization recorded on the page: anthropic excludes them from
`input_tokens`, OpenAI includes them in `prompt_tokens` — the W045/W118
caps and the metering trail mean the same thing on both lanes, and the
W119-aggregated abort tier now sees the anthropic lane's real token
mass); the SSE stream accumulates last-observed-per-field and emits ONE
usage event per message at stream end (usageEvents semantics unchanged:
1/message on both lanes); the raw anthropic fields ride `onUsage`
untouched (P12's seam); the cost boundary (the anthropic usage carries
no cost field — the lane's local cost stays unmeasured, bounded
server-side by the OpenRouter per-key credit limit) and the transform
boundary (the lane stays untransformed — the governance half of P9
stands) recorded in the extraction's docs.

**Red/green:** the pins authored FIRST against the pre-change src:
2 red (the JSON lane's real-token sums: prompt 220 / completion 30 /
total 250 from input 120 + cache 40/60; the SSE lane's one-event-per-
message accumulation: usageEvents 1 with prompt 79 / completion 23 /
total 102 from the cumulative start+delta pair — NOT the naive += 88/24)
— runtime reds only (no new exports, so no compile-level red this
iteration, unlike W122); 2 regression hold-outs green before AND after
by design (an anthropic error payload meters nothing; a chat-completions
usage with anthropic-style keys still records zeros — the type-keyed
boundary frozen as-found); the 15 pre-existing pins green throughout.
After: 19/19 model-usage-proxy; 23/23 consumers (session-budget 17 +
open-model-proxy 6); lint exit 0; typecheck exit 0.

**Acceptance criteria:**
- [x] The anthropic JSON lane records real tokens (the zero-token
      pollution closed; usageEvents unchanged at 1/message).
- [x] The anthropic SSE stream emits ONE usage event per message from
      the cumulative events (the double-count hazard discriminated by
      exact sums).
- [x] The cache components normalize into the prompt side with the
      rationale on the page; the raw fields ride onUsage (P12's seam —
      no wire re-derivation needed later).
- [x] The two prerequisite records landed (the usage shape; the replay
      policy's Messages-schema compatibility) plus the cost and
      transform boundaries.
- [x] The chat-completions lanes are untouched (the two existing frozen
      pins + the type-keyed hold-out).

**Deliberately NOT done:** the transform-governance half of P9
(shaping/markers/downgrade on the messages lane) — decision-first,
stands as the recorded residual; the Messages-schema replay integrity
check — the queued successor decision; the metrics model's first-class
cache fields — P12's next loop (the operator-starred order), now
unblocked since the trail is trustworthy. Recorded residual (the
review round-1 P3): a mid-stream reader failure on the anthropic SSE
lane loses the buffered pending record (no emit) where the
chat-completions lane keeps partial parse-time usage — the failure-
path asymmetry is unmeasured and unpinned, left to P12's loop (the
pre-W123 baseline on that path was zero-token pollution, so no
regression). Region note: W121 (and the
LESS-0046 slot) stay free for the concurrent stream; this lands as
W123/LESS-0047 off main@74a13a0.
