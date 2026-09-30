<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — the record
of the P8 sub-minimum-prefix confound correction and the P11 prerequisite
evidence. Write-once: append dated supersession notes, never rewrite. Park P8
(#287) and P11 (#290) stay OPEN; this fragment corrects the recorded provider/
family cache-marker verdicts and records the cache-accounting prerequisite, it
does not land either item. -->

# P8 prefix-correction: the sub-minimum-prefix cache confound

**Date:** 2026-09-30. **Branch:** `docs/p8-prefix-correction`. **Issues:** #287
(P8), #290 (P11).

## What was wrong

The P8 provider-lane and family-lane verdicts (`docs/PROBE_VERDICTS.json` ids
`vendor-anthropic-cache-provider` and `vendor-anthropic-cache-families`) were
recorded `negative`: the endpoints returned 2xx with `cache_creation_input_tokens:
0` / `cache_read_input_tokens: 0`, read as "accepted the markers but did not
account for them".

The composed probe body was **~581 input tokens** (559-char serialized JSON; 177
marked-text chars: a 72-char system string + a 75-char tool description + a
30-char user turn). That is **below Anthropic's ~1024-token cache minimum**
(Sonnet-class models; Haiku's minimum is 2048). Below the minimum a marked prefix
is not cache-**eligible**, so the endpoint returns the same 0/0 whether or not it
understands the `cache_control` marker. The recorded 0/0 was therefore a
prefix-size artifact, **not** evidence that the endpoint rejects or ignores the
markers. The markers themselves were accepted (2xx, well-formed Messages body).
The confound applied to the provider row AND the family rows.

## New evidence (live, 2026-09-30, orchestrator-run, direct to the deployed route)

`POST https://openrouter.ai/api/v1/messages`, model `anthropic/claude-sonnet-4.5`
(provider **Amazon Bedrock**), a system block carrying `cache_control:
{type:"ephemeral"}` over a ~4.8k-token shared prefix, two sequential turns with
the same prefix:

| Turn | Status | cache_creation_input_tokens | cache_read_input_tokens | input_tokens | output_tokens |
|---|---|---|---|---|---|
| 1 | 200 | 4802 | 0 | 13 | 4 |
| 2 (same prefix, different user turn) | 200 | 0 | 4802 | 13 | 4 |

The deployed route DOES account provider-side prefix cache (creation then read)
once the marked prefix is large enough.

## The instrument fix (small-safe, applied)

`test/vendor-anthropic-cache-probe.test.ts` now generates the marked system
prefix via `buildSharedPrefix()` to clear `MINIMUM_MARKED_PREFIX_TOKENS` (1024)
with margin: `1024 * 4 chars/token * 2` targeting 8192 chars, producing **8341
chars (~2000 tokens)**. An ungated floor pin ("the marked prefix clears the
provider cache minimum") freezes the char floor so the probe cannot silently
shrink back under the minimum. The existing marker-shape pins and the provider
base-URL/gate-selection pins are unchanged and stay green (5 pass, 0 fail, 4
skipped ungated).

### Provider-lane re-run (live, 2026-09-30)

`WORKFLOW_VENDOR_CACHE_PROBE=provider`,
`WORKFLOW_PROVIDER_ANTHROPIC_URL=https://openrouter.ai/api/v1`,
`WORKFLOW_PROVIDER_MODEL=anthropic/claude-sonnet-4.5`, key from
`~/.config/workflow/cline-api-key`:

- HTTP 200, well-formed Messages body, `stop_reason: "end_turn"`, response
  provider **Amazon Bedrock**.
- Request markers: `systemMarker` present with `cache_control:
  {type:"ephemeral"}`, `lastToolMarker {type:"ephemeral"}`, `boundaryMarker
  {type:"ephemeral"}`.
- `cacheUsage` = `cache_creation_input_tokens: 2035`,
  `cache_read_input_tokens: 0`, `input_tokens: 3`, `output_tokens: 4`.

A single-request probe can only show cache **creation**; the read requires a
second turn with the same prefix. The two-turn direct evidence above supplies
the read.

## Record changes

- `docs/PROBE_VERDICTS.json`: `vendor-anthropic-cache-provider` moved
  `negative -> green` (accepted AND accounted); posture advisory. The original
  observation is preserved inside the corrected note. `vendor-anthropic-cache-
  families` retracted `negative -> blocked` / `unqualified` with a blocker: its
  bodies carried the same sub-minimum prefix, so its `negative` was an artifact;
  the direct arms must be re-run with the enlarged prefix (no family keys were
  available here). Anti-drift test green.
- `docs/HOST_ADAPTERS.md`: dated correction entry appended under "Vendor
  anthropic cache-marker probes".
- `docs/PARKED_AND_LIMITATIONS.md`: dated note appended to the P8 row and to the
  L8 limitation; the P11 row gains the **prerequisite evidence** (cache
  accounting works on the deployed route, so the with/without-affinity
  comparison is meaningful).

## P11 prerequisite (recorded, not measured)

The P11 prerequisite — provider-side cache accounting on the deployed route —
is now PROVEN (the creation/read pair above, and the green probe re-run). The
with/without-affinity comparison is therefore meaningful rather than a
measurement of the prefix-size confound. P11's OWN with/without-affinity
measurement remains operator-run and issue #290 stays OPEN.

## Boundaries

- Docs + instrument only. The W109 `cacheMarkers` opt-in still stays dark for
  every family until the per-family verdicts land (probe-gated, never
  date-gated).
- The provider row is `advisory` (observability, not enforcement): a cache field
  is never evidence of hub enforcement.
- The green covers the deployed provider lane (`anthropic/claude-sonnet-4.5` via
  OpenRouter/Bedrock); it does not by itself cover the deepseek/glm/kimi models,
  whose direct arms remain unrun.
