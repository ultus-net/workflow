# P8 live-run recipe: the vendor anthropic cache-marker probe

**Status: BLOCKED / UNQUALIFIED until a live run.** The probe harness and this
recipe exist; the per-lane live verdicts do not. The register row
`vendor-anthropic-cache` (`docs/PROBE_VERDICTS.json`) stays `blocked` /
`unqualified` until the operator runs the probe and records the dated result.
Nothing here earns a caching claim by existing, and the W109 `cacheMarkers`
opt-in stays dark for every family until a live verdict lands (probe-gated,
never date-gated).

**What this is:** the turnkey operator runbook for P8 / issue #287. It
collects, in one place, the exact commands, what to read in the output, the
templates for recording a verdict, and the known watch items. The harness
source of truth is `test/vendor-anthropic-cache-probe.test.ts`; the landing
records are `docs/ledger/P8-vendor-cache-probe-harness.md` (the harness) and
`docs/ledger/P8p-provider-lane-probe.md` (the provider-lane re-frame).

**The question P8 asks:** do anthropic-compatible endpoints accept the
Messages-schema `cache_control` markers that `applyCacheMarkers`
(`src/integrations/model-profile.ts`) emits on the system block, the last tool
definition, and (since P13, issue #292) the previous turn's boundary block?
The deployed lane is a **reseller/provider** route (Azure AI Foundry or
OpenRouter), not direct vendor API keys. The direct per-family arms stay
because they measure the vendor contracts themselves, but they are **not** the
deployed route.

## 1. The run

Run from the repo root. The provider lane is the DEPLOYED route; the direct
per-family arms are optional and measure the vendor contracts only.

```bash
# Provider lane (the DEPLOYED reseller route: Azure AI Foundry or OpenRouter).
# WORKFLOW_PROVIDER_ANTHROPIC_URL accepts a bare host, a /v1 base, or a full
# /messages URL (the normalizer never doubles the path).
WORKFLOW_VENDOR_CACHE_PROBE=provider \
  WORKFLOW_PROVIDER_ANTHROPIC_URL=https://openrouter.ai/api/v1 \
  WORKFLOW_PROVIDER_API_KEY=sk-... \
  WORKFLOW_PROVIDER_MODEL=anthropic/claude-... \
  node --import tsx --test test/vendor-anthropic-cache-probe.test.ts

# Direct per-family arms (NOT the deployed lane; they measure the vendor
# contracts). Keys resolve from env or the 0600 ~/.config/workflow/<family>-api-key
# file. Uncomment to run. A keyed family probes; an unkeyed one skips by name.
# WORKFLOW_VENDOR_CACHE_PROBE=all \
#   DEEPSEEK_API_KEY=... ZAI_API_KEY=... MOONSHOT_API_KEY=... \
#   node --import tsx --test test/vendor-anthropic-cache-probe.test.ts
```

Gate tokens: `provider` (the deployed lane), `deepseek`, `glm`, `kimi`, a
comma/space list, or `all` (families only, never the provider lane). The
gate is `WORKFLOW_VENDOR_CACHE_PROBE`; `all` deliberately does **not** arm the
provider lane, so the reseller route is only ever run when you ask for it.

Family key env names (`src/integrations/open-model-keys.ts`):
`DEEPSEEK_API_KEY` / `WORKFLOW_DEEPSEEK_API_KEY`; `ZAI_API_KEY` /
`GLM_API_KEY` / `WORKFLOW_GLM_API_KEY`; `MOONSHOT_API_KEY` / `KIMI_API_KEY` /
`WORKFLOW_KIMI_API_KEY`.

## 2. What to read in the output

The ungated structural pins run first, then each selected lane's live arm (an
unselected or unkeyed arm skips by name). Ungated the file reports **4 pass,
0 fail, 4 skipped** (three family arms + the provider arm). A provider run
with all env set and a healthy endpoint reports the 4 ungated passes plus the
provider live pass (3 family skips).

**Marker placement (the request-side assertion).** The committed pins freeze
the composed request ungated, so a marker regression goes red before any
network call. On the live run the arm also prints the markers it sent, under
`request`:

```json
"request": {
  "systemMarker":   { "type": "ephemeral", "text": "The Workflow vendor cache-marker probe..." },
  "lastToolMarker": { "type": "ephemeral" },
  "boundaryMarker": { "type": "ephemeral" }
}
```

Read it as: `systemMarker.cache_control`, `lastToolMarker`, and
`boundaryMarker` must each be the ephemeral marker. If any is missing or
`null`, the production marker pass regressed (the ungated pin should already
have caught it). The `boundaryMarker` is the P13 per-turn breakpoint on the
last message's final content block; it is recorded since issue #292, so the
live verdict witnesses the deployed placement, not only the static head.

**Cache usage (the response-side observation).** Under `cacheUsage`:

```json
"cacheUsage": {
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "input_tokens": 18,
  "output_tokens": 1
}
```

These are **observed, never asserted**. A green live arm only requires a 2xx,
a well-formed Messages body, and numeric `input_tokens` / `output_tokens`. It
does **not** require the cache fields to be present or positive; their value
is the live finding you record. Presence and nonzero mass mean the endpoint
accounted for the marked prefix as cache creation or cache read; absent or
zero means the endpoint accepted the body but did not account for the markers
(an honest non-effect, not a crash).

## 3. The verdict-record templates

Record in two layers, together (the register keeps docs and runtime claims
from drifting; the anti-drift test resolves every cited path).

**a. The register row** (`docs/PROBE_VERDICTS.json`, id
`vendor-anthropic-cache`). When a lane runs, paste the printed block, flip the
row, and advance the top-level `updated` stamp (it may never predate the
newest verdict date). The row shape:

```json
{
  "id": "vendor-anthropic-cache",
  "host": "anthropic-compatible cache-marker lanes (direct deepseek/glm/kimi arms + the generic Azure/OpenRouter provider lane)",
  "hostVersion": "per-lane (recorded per run)",
  "probe": "test/vendor-anthropic-cache-probe.test.ts",
  "gate": "WORKFLOW_VENDOR_CACHE_PROBE",
  "date": "<YYYY-MM-DD>",
  "result": "green",
  "posture": "advisory",
  "evidence": "docs/HOST_ADAPTERS.md Vendor anthropic cache-marker probes; docs/P8_LIVE_RUN_RECIPE.md",
  "note": "<lane, model id, endpoint, the observed request markers and cacheUsage fields, accept/reject/error>"
}
```

Result mapping (the operator decides; keep `blocked` if the run is ambiguous):

| Observed | `result` | `posture` |
|---|---|---|
| 2xx, well-formed Messages body, cache fields present/positive | `green` | `advisory` |
| 2xx, well-formed body, cache fields absent or zero (markers inert on this endpoint) | `negative` | `advisory` |
| non-2xx or malformed body (request/marker rejected) | `red` | `advisory` |
| not run / ambiguous | `blocked` | `unqualified` (keep the `blocker`) |

`blocked` rows must keep a non-empty `blocker`. This row is a single
per-family-family row for register simplicity; split it into per-lane rows
when the first verdict lands if per-lane granularity is wanted (the P8p
fragment records that choice). A partial run (for example provider lane only)
either narrows the existing `blocker` to the still-unrun lanes or splits the
row, never silently widens a `green` to cover an unrun lane.

After editing, re-run the anti-drift test green:
`node --import tsx --test test/probe-verdict-register.test.ts`.

**b. The `docs/HOST_ADAPTERS.md` write-up** (create the section "Vendor
anthropic cache-marker probes" on the first verdict). One dated entry per
lane, in the probe-verdict prose style already used in that file:

```markdown
**<YYYY-MM-DD> (vendor anthropic cache-marker probe - <lane>: <provider/model> - live on <endpoint>):**
`test/vendor-anthropic-cache-probe.test.ts` (`WORKFLOW_VENDOR_CACHE_PROBE=provider`,
`WORKFLOW_PROVIDER_ANTHROPIC_URL=...`, `WORKFLOW_PROVIDER_MODEL=...`) ran live
against <reseller> (Azure AI Foundry / OpenRouter). The composed body carried the
ephemeral markers on the system block, the last tool, and the previous turn's
boundary block (recorded `request.*Marker` = `{"type":"ephemeral"}`). The endpoint
returned 2xx with a well-formed Messages body; observed `cacheUsage` =
`cache_creation_input_tokens: N`, `cache_read_input_tokens: M`,
`input_tokens: K`, `output_tokens: L`. Verdict: <accepted with cache accounting /
accepted but no cache accounting / rejected (HTTP N)>. Register row
`vendor-anthropic-cache` moved <blocked -> green|negative|red>; posture advisory
(observability, not enforcement).
```

Await a second request with the same prefix before claiming a cache **read**:
the first marked request can only show creation. One run records one
observation, not a cache-hit rate.

## 4. Watch items

- **The provider arm sends a dual auth header.** It deliberately rides BOTH
  `x-api-key` (anthropic-native / Azure) and `Authorization: Bearer`
  (OpenRouter) on the one request
  (`test/vendor-anthropic-cache-probe.test.ts:416-422`), so one env spans the
  resellers. A gateway MAY reject the extra header with a 4xx **before the
  body reaches the model**. On a non-2xx, do NOT record a marker red: replay
  with ONLY the header the target expects, and only then record the lane's
  marker accept/reject verdict. The auth header is not what P8 measures. Full
  disposition: `docs/ledger/P8p-provider-lane-probe.md` (dated watch-item
  note, 2026-09-30).
- **The boundary marker is now recorded.** Since P13 / issue #292 the marker
  pass places one breakpoint on the previous turn's end. The probe prints
  `request.boundaryMarker` so the live verdict sees that deployed placement; a
  live response's cache fields may reflect the boundary breakpoint as well as
  the static head. Do not read a missing boundary marker as a marker red
  without first confirming the ungated structural pin is still green.
- **Observability, not enforcement.** Even a green run caps these lanes at
  `advisory`. The probe measures whether an endpoint accepts and accounts for
  the markers; it makes no authority claim, and a cache field is never
  evidence of hub enforcement.

## 5. Boundaries

- Docs-only runbook. No live call is made by this document or its tests; the
  live verdicts remain the operator's.
- The register row stays `blocked` / `unqualified` until the run.
- The W109 `cacheMarkers` opt-in stays dark for every family until the
  operator's per-lane verdicts. P8 / issue #287 and the dependent P14 /
  issue #293 stay open.
