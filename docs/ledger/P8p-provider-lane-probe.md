<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — this is the record of the P8 lane RE-FRAME and the generic provider-lane probe arm, not a landed live verdict. Write-once: append dated supersession notes, never rewrite. Park P8 and issue #287 stay OPEN — the live run is the operator's. -->

### P8p - The provider-lane re-frame (Complete - the deployed reseller/provider lane is now the operator-runnable probe path; the live verdicts remain operator-gated/unrun) (issue #287 P8; the gated probe test + docs, no production change) (2026-09-30)

**Source:** issue #287 (P8, docs/PARKED_AND_LIMITATIONS.md:37, L8 at :61) and
the operator's answer that changes the premise: production traffic does NOT use
direct vendor API keys — it crosses a reseller/provider (Azure AI Foundry or
OpenRouter) anthropic-compatible lane. The landed harness
(`docs/ledger/P8-vendor-cache-probe-harness.md`) armed only the three direct
per-family arms (deepseek/glm/kimi), which measure the vendor contracts
themselves but are NOT the deployed route. This fragment records the re-frame
and the new generic lane. The marker under probe is unchanged: the
`applyCacheMarkers` shape (`{ type: "ephemeral" }` on the system block and the
last tool definition of an anthropic-wire body; messages lane deliberately
unmarked — the P13 boundary policy owns that decision,
src/integrations/model-profile.ts:253-273).

**What landed:**

1. **A GENERIC provider lane in `test/vendor-anthropic-cache-probe.test.ts`.**
   The gate token `provider` (in `WORKFLOW_VENDOR_CACHE_PROBE` alongside the
   family tokens) plus `WORKFLOW_PROVIDER_ANTHROPIC_URL` /
   `WORKFLOW_PROVIDER_API_KEY` / `WORKFLOW_PROVIDER_MODEL` sends the SAME
   marker-shaped anthropic body through the operator's reseller base URL, so
   the operator can point one env at OpenRouter or Azure AI Foundry. The base
   URL normalizer accepts a bare host, a `/v1` base, or a full `/messages` URL
   without doubling the path. `all` stays families-only; the provider lane is
   opted in explicitly, so the reseller route is never run implicitly.
2. **The provider lane reuses the production marker pass, so the composed
   shape did not change** — `modelProfile({ wire: "anthropic", cacheMarkers:
   true })` → `applyCacheMarkers` is family-independent under the boolean
   opt-in, and `shapeRequestBody` is not applied, so no vendor
   reasoning/sampling field rides the wire. A SECOND ungated structural pin
   freezes the provider lane's composed request (same assertion as the family
   pin, factored into `assertMarkerShape`). Because the shape did not change,
   there was no marker-shape red to earn: red-first is not applicable to the
   lane itself. That rationale is NARROWED, not waved: the provider lane's new
   helper logic (the base-URL normalizer `providerMessagesUrl` and the
   `provider`-token selection `providerLaneSelected`) DID exist to be pinned,
   even though no live marker-shape red was available at the time. Both helpers
   are now covered by ungated unit pins (bare host, `/v1` base, full `/messages`
   URL, trailing slash, the no-doubling property, and the `all`-stays-
   families-only selection), so a path-doubling or selection regression can no
   longer ship inside the gated arm.
3. **The direct per-family arms STAY, honestly labeled.** They still measure
   the vendor contracts (`VENDOR_DEFAULTS[…].anthropicEndpoint`), but the file
   header, the P8 row, and the register row now record that they are NOT the
   deployed lane.
4. **Docs/register re-frame:** the P8 row and L8 limitation got the dated
   lane-re-frame note; the `vendor-anthropic-cache` register row's `host`,
   `blocker`, `note`, and `evidence` were updated (the blocker now names the
   provider lane's env as the deployed route and the per-family keys as
   not-deployed). The gate and the row's `blocked`/`unqualified` result are
   unchanged.
5. **The ungated skip path and the ungated structural pins are intact**: no
   gate or missing env produces a named skip and no network call.

**Run recipe (the operator's — the DEPLOYED lane):**

```bash
# The generic reseller/provider lane (Azure AI Foundry or OpenRouter),
# from the repo root with the provider env in the environment:
WORKFLOW_VENDOR_CACHE_PROBE=provider \
  WORKFLOW_PROVIDER_ANTHROPIC_URL=https://openrouter.ai/api/v1 \
  WORKFLOW_PROVIDER_API_KEY=sk-… \
  WORKFLOW_PROVIDER_MODEL=anthropic/claude-… \
  node --import tsx --test test/vendor-anthropic-cache-probe.test.ts
```

`WORKFLOW_PROVIDER_ANTHROPIC_URL` is the anthropic-compatible base the
operator's provider exposes (a bare host, a `/v1` base, or a full `/messages`
URL all normalize). Both common auth headers ride (`x-api-key` for
anthropic-native/Azure, `Authorization: Bearer` for OpenRouter); an endpoint
that rejects the extra header is a live finding to record. The arm prints one
JSON block (`lane: "provider"`) with the request markers and the response's
cache usage — that block IS the measurement; copy it into the dated verdict.
The direct per-family arms' recipe is unchanged
(`docs/ledger/P8-vendor-cache-probe-harness.md`).

**Where the verdict gets recorded (unchanged proposal):** the register row
stays machine-readable and `blocked` until a live run; the human write-up
belongs in a new `docs/HOST_ADAPTERS.md` section ("Vendor anthropic
cache-marker probes"), one dated row per lane (provider lane + each direct
family: model id, endpoint, observed cache fields, accept/reject/error, date).
When a lane runs, paste its printed block, flip the register entry from
`blocked` to green/red, and advance the register stamp.

**Evidence:**

- Ungated, `node --import tsx --test test/vendor-anthropic-cache-probe.test.ts`
  → **8 tests: 4 pass, 0 fail, 4 skipped** (the three family arms + the provider
  arm), each skip naming its missing env; exit 0. The four passes are the two
  ungated structural pins (family + provider marker shape) plus the two new
  ungated helper pins: `providerMessagesUrl` (bare host, `/v1` base, full
  `/messages` URL, trailing slash, and the no-doubling property) and
  `providerLaneSelected` (`all` stays families-only; only the explicit
  `provider` token selects the lane).
- Under `WORKFLOW_VENDOR_CACHE_PROBE=provider` with no provider env: the three
  family arms skip with the selection reason and the provider arm skips with
  `no provider base URL: set WORKFLOW_PROVIDER_ANTHROPIC_URL (an
  anthropic-compatible reseller endpoint)` — no network call.
- The register's anti-drift test
  (`node --import tsx --test test/probe-verdict-register.test.ts`) green: the
  row's gate/file/evidence stay in lockstep (the new fragment is a cited
  evidence path that exists).
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Boundaries (remain):** the live per-lane verdicts are UNRUN — the operator's
run is what flips the register. The W109 marker opt-in stays dark for every
family until a live verdict. P8/issue #287 stays OPEN and P14/issue #293 stays
blocked on it. No production change.
