<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### OpenCode v2 open-source vendor lane (W070a): v2-valid BUILT-IN provider routing (landed) (2026-09-30)

**Source:** the W070a residual recorded by PR #427's ledger
(`docs/ledger/opencode-v2-metered-config.md`, "v2 open-source vendor providers
probe-pending") and PR #428's
(`docs/ledger/opencode-v2-server-lane.md`, "the v2 open-source vendor provider
registration gap (W070a) stays open"): `meteredOpencodeConfig` emitted the
open-source pool as config-defined CUSTOM providers (`package:
"@opencode/ai/providers/openai-compatible"`), which opencode v2 parses but does
NOT register into the ACP model catalog, so the family lane was unselectable on
v2. GitHub issue #284.

**v2 BUILT-IN provider ids (the fix's premise).** opencode's provider catalog is
models.dev. The three open-source families map to its built-in ids, and each
built-in's catalog already carries the pool's exact model ids:

| Workflow family | pool model(s) | v2 built-in provider id | v2 activation env key | built-in catalog base |
|---|---|---|---|---|
| `deepseek` | `deepseek-flash` | `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| `glm` | `glm-5.3`, `glm-5.3-flash` | `zai` | `ZAI_API_KEY` | `https://api.z.ai/api/paas/v4` |
| `kimi` | `kimi-k3` | `moonshotai` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` |

The ids/env keys were read from the pinned **opencode v2.0.10** binary's bundled
catalog (`strings` over the self-contained binary; the strings
`"deepseek"`/`"zai"`/`"moonshotai"` and `"DEEPSEEK_API_KEY"`/`"ZAI_API_KEY"`/
`"MOONSHOT_API_KEY"` are present) and **confirmed live** (below). Note: current
models.dev lists `ZHIPU_API_KEY` for `zai`, but the pinned v2.0.10 binary reads
`ZAI_API_KEY` (0 occurrences of `ZHIPU_API_KEY`), so the mapping follows the
binary, not the live catalog — a version-pinned fact, re-check on a version bump.

**The fix (version-aware; v1 unchanged by construction).**

- `src/integrations/opencode-agent-config.ts`
  - New `OPENCODE_V2_VENDOR_BUILTINS` (family → `{ providerId, envKey }`,
    lines 72-76) and `OpenSourceV2BuiltinProvider`; `MeteredVendorProvider`
    gains an optional `v2ProviderId` (line 96) — the v2 built-in the vendor
    overrides. Absent means the vendor has NO v2 built-in (recorded, not
    fabricated).
  - `v2Providers()` (lines 216-227) now emits each vendor as
    `providers.<v2ProviderId>.settings.baseURL`—the v2 docs' "Endpoint" route,
    which keeps the built-in package/models/connection—instead of a custom
    `package` provider. A vendor without `v2ProviderId` is omitted.
  - `v2DefaultModel()` (lines 232-241) translates the composed open-source
    default (`workflow-<family>/<model>`) to the built-in ref
    (`<built-in>/<model>`); no v2 built-in falls back to the Auto Router.
  - v1 is byte-identical: `v1Provider()` and the v1 default path are untouched,
    and `v2ProviderId` is ignored on v1.
- `src/integrations/acp-runtime.ts`
  - `openSourceConfig` tags each provider with `v2ProviderId` from the map
    (lines 490-498).
  - The v2 launch environment now adds each composed vendor's placeholder env
    key (`v2VendorEnv`, lines 342-347, spread at line 417) beside the metered
    `OPENROUTER_API_KEY`; the 0600 config stays credential-free.
- `test/opencode-v2-vendors-config.test.ts` (new, 5 tests): the family→built-in
  mapping, the v2 built-in override + default translation + credential-free
  file, the explicit-override path, the byte-identical v1 custom-provider
  emission, and the no-pool v2 fallback.
- `test/opencode-v2-metered-config.test.ts` updated: the vendor case asserts the
  built-in override (no `package`, translated default) and a new case pins the
  no-built-in omission/fallback.
- `test/opencode-v2-vendors-probe.test.ts` (new, gated
  `WORKFLOW_OPENCODE_V2_VENDORS=1`): builds the ACTUAL emitted config, points the
  vendor baseURL at a local mock, runs the real `opencode serve`, and asserts the
  session ran on the built-in id with the placeholder bearer.

**LIVE green evidence (v2.0.10, 2026-09-30).** `WORKFLOW_OPENCODE_V2_VENDORS=1
node --import tsx --test test/opencode-v2-vendors-probe.test.ts`:

```
# { "family": "deepseek", "builtin": "deepseek", "envKey": "DEEPSEEK_API_KEY",
#   "providerID": "deepseek", "modelID": "deepseek-flash", "mockRequests": 11,
#   "mockAuth": "Bearer workflow-metered" }
ok 1 - open-source vendor deepseek routes through its v2 built-in provider to the proxy
# { "family": "glm", "builtin": "zai", "envKey": "ZAI_API_KEY",
#   "providerID": "zai", "modelID": "glm-5.3", "mockRequests": 11,
#   "mockAuth": "Bearer workflow-metered" }
ok 2 - open-source vendor glm routes through its v2 built-in provider to the proxy
# { "family": "kimi", "builtin": "moonshotai", "envKey": "MOONSHOT_API_KEY",
#   "providerID": "moonshotai", "modelID": "kimi-k3", "mockRequests": 11,
#   "mockAuth": "Bearer workflow-metered" }
ok 3 - open-source vendor kimi routes through its v2 built-in provider to the proxy
1..3 / # pass 3 / # fail 0 / # skipped 0
```

Four additional scratch probes against the REAL `opencode serve` (not
committed) established the table above before implementation: each built-in id
with `providers.<id>.settings.baseURL` = a local mock + its placeholder env key
ran the session on `providerID: <id>` and delivered `Bearer workflow-metered` to
the mock. Without the env key the provider does not activate.

**No-regression (v2.0.10, 2026-09-30).** `WORKFLOW_ACP_OPENCODE_METERED=1
test/acp-opencode-metered-probe.test.ts` green (`end_turn`, requests 3 /
usageEvents 2 / totalTokens 12341, workspace command ran). The gated probe skips
without its gate (3 skipped).

**Verification hygiene.** `npm run lint` exit 0; `npm run typecheck` exit 0
(unpiped). Focused suites: `opencode-v2-vendors-config` +
`opencode-v2-metered-config` + `opencode-open-source-config` = **14/14 pass**;
`acp-runtime-agent` + `open-model-proxy` + `open-source-pool` +
`open-model-keys` + `opencode-v2-server-config` + `auto-compact-config` =
**37/37 pass, 0 fail**.

**Residuals (stated honestly).**

- **The ACP picker registration for vendor built-ins is inferred, not
  separately probed.** The committed probe exercises the server/HTTP lane (which
  honors the config `model`); it shows a credential-activated built-in
  registers and routes. The ACP lane pins the same ref via
  `session/set_config_option` (#427), but a vendor built-in ref in the ACP
  picker was not live-run here — the ACP metered regression (openrouter) was.
- **v2 exposes the full built-in vendor catalog, not the pool subset.** The v2
  "Endpoint" override keeps the built-in's models, so the picker lists every
  `deepseek/*`, `zai/*`, `moonshotai/*` model rather than only the pool's
  models. Extra models still route through the vendor proxy (metered) but have
  no family `ModelProfile`, so their request shaping is the pass-through default
  — matching #427's full-openrouter-catalog trade-off.
- **The server/topology lane does not compose `openSource`.** It passes no
  `openSource` to `meteredOpencodeConfig`, so no vendor env key is set there; a
  vendor pool on that lane would be unactivated. Wiring it is a follow-up, not
  affected by (nor fixed by) this change.
- **v1 not live-tested.** The host carries only opencode v2.0.10. v1 emission is
  unchanged by construction and pinned by the v1 unit cases.
- **Version-pinned env key.** `zai`'s activation var is `ZAI_API_KEY` on
  v2.0.10 while live models.dev now says `ZHIPU_API_KEY`; a future opencode
  version bump must re-check this table (probe-gated, per AGENTS.md).
- **v2 `permission` spelling unprobed** (pre-existing probe debt; the composed
  object is the v1 spelling).
