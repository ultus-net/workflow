<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### OpenCode v2 ACP-lane vendor picker/route: live-verified + catalog-valid model pin (landed) (2026-09-30)

**Source:** the residual PR #431 left (`docs/ledger/opencode-v2-vendors.md`,
"the ACP picker registration for vendor built-ins is inferred, not separately
probed"). GitHub issue #284. The ACP metered lane needed a `selectModel` pin
because v2's `session.new` default ignores the config `model` (#427); the vendor
built-ins were assumed to ride that same pin.

**The finding (live, opencode v2.0.10, 2026-09-30).** The ACP `model` picker
**validates** `session/set_config_option` against the provider catalog, unlike
the server/HTTP lane (which forwards any `model` ref). Two #431 assumptions did
not survive the ACP lane:

1. **`ZAI_API_KEY` does not activate `zai`.** A live ACP session with
   `providers.zai.settings.baseURL` + `ZAI_API_KEY` advertised **no** `zai/*`
   model (picker prefixes: `["opencode"]`); the same config with `ZHIPU_API_KEY`
   registered `zai` (and its catalog). opencode reads the fetched models.dev
   catalog's `env` (now `ZHIPU_API_KEY`), not the binary's bundled string. The
   #431 server-lane proof could not see this: the HTTP lane routes an explicit
   `model` ref without activation.
2. **The pool model ids are mostly absent from the v2.0.10 built-in catalogs.**
   `deepseek-flash` is not in the `deepseek` catalog (it lists
   `deepseek-chat`/`-reasoner`/`-v4-flash`/`-v4-pro`); `glm-5.3`/`glm-5.3-flash`
   are not in the `zai` catalog (it tops out at `glm-5.2`); only `kimi-k3`
   matches `moonshotai`. The connector's pin of the pool id therefore failed the
   whole ACP session with
   `-32602 Invalid params: model not found: deepseek/deepseek-flash`.
   No config `models` shape (map/array/full-models.dev/package/npm) adds models
   to a v2 built-in provider — the built-in catalog is fixed (live-tested six
   shapes).

**The fix (version-aware; v1 unchanged by construction).**

- `src/integrations/opencode-agent-config.ts`
  - `OPENCODE_V2_VENDOR_BUILTINS.glm.envKey`: `ZAI_API_KEY` → `ZHIPU_API_KEY`
    (live-verified activation).
  - New `OPENCODE_V2_VENDOR_MODELS` (built-in id → { pool model → catalog
    model }): `deepseek` maps `deepseek-flash` → `deepseek-v4-flash` (the
    vendor-accepted legacy id for the same DeepSeek-V4.1-Flash, W070a spec §2),
    `moonshotai` maps `kimi-k3` → `kimi-k3` (identity), and `zai` is
    deliberately ABSENT (no faithful v2.0.10 model id).
  - New `v2BuiltinModelRef(ref)`: translates a vendor built-in pool ref to its
    catalog id; an unmappable vendor ref (GLM) falls back to the metered Auto
    Router (`openrouter/auto`) — metered, never a different vendor model; any
    non-vendor ref passes through unchanged.
- `src/integrations/acp-runtime.ts`
  - The v2 `selectModel` pin now uses `v2BuiltinModelRef(opencodeConfig.model)`
    so it is a ref the picker accepts. The config `model` emission is unchanged
    (the server lane and v1 are byte-identical).

**LIVE green evidence (v2.0.10, 2026-09-30).** `WORKFLOW_OPENCODE_V2_VENDORS_ACP=1
node --import tsx --test test/opencode-v2-vendors-acp-probe.test.ts`:

```
# { "family": "deepseek", "builtin": "deepseek", "envKey": "DEEPSEEK_API_KEY",
#   "ref": "deepseek/deepseek-v4-flash", ... "mockAuth": "Bearer workflow-metered",
#   "mockBodyModel": "deepseek-v4-flash", "stopReason": "end_turn" }
ok 1 - open-source vendor deepseek's v2 built-in is picker-registered and routes an ACP turn through the proxy
# { "family": "kimi", "builtin": "moonshotai", "envKey": "MOONSHOT_API_KEY",
#   "ref": "moonshotai/kimi-k3", ... "mockBodyModel": "kimi-k3", "stopReason": "end_turn" }
ok 2 - open-source vendor kimi's v2 built-in is picker-registered and routes an ACP turn through the proxy
# { "family": "glm", "builtin": "zai", "envKey": "ZHIPU_API_KEY",
#   "mockBodyModel": "glm-4.5", "stopReason": "end_turn" }
ok 3 - open-source vendor glm's zai built-in is picker-registered and routes an ACP turn through the proxy
1..3 / # pass 3 / # fail 0 / # skipped 0
```

Each probe: the picker advertised the pinned ref (deepseek/kimi) or the `zai`
built-in's catalog (glm), the turn completed `end_turn`, and the mock observed
the vendor built-in traffic with only the placeholder bearer.

**No-regression (v2.0.10, 2026-09-30).** The server-lane probe
`WORKFLOW_OPENCODE_V2_VENDORS=1 test/opencode-v2-vendors-probe.test.ts` stays
3/3 (the HTTP lane routes the pool ids; the env-key change did not regress it).
`WORKFLOW_ACP_OPENCODE_METERED=1 test/acp-opencode-metered-probe.test.ts` green
(`end_turn`, requests 3 / usageEvents 2 / totalTokens 12507). Focused unit
suites: `opencode-v2-vendors-config` 6/6, `opencode-v2-metered-config` 6/6.
`npm run lint` exit 0; `npm run typecheck` exit 0 (unpiped).

**Residuals (stated honestly).**

- **GLM-5.3 cannot be pinned on the v2.0.10 ACP lane.** Its `zai` catalog has no
  `glm-5.3`/`glm-5.3-flash`, so the connector falls back to the metered Auto
  Router rather than silently downgrading to `glm-5.2`. The `zai` built-in's own
  catalog models remain selectable and proxied (live-proven: `zai/glm-4.5`
  routed). Re-check on every opencode bump; if a future catalog carries
  `glm-5.3`, add it to `OPENCODE_V2_VENDOR_MODELS.zai`.
- **Version-pinned catalog ids.** `deepseek-v4-flash`/`kimi-k3` are the v2.0.10
  catalog spellings; a version bump must re-run the probe (per AGENTS.md).
- **Pool ModelProfile shaping is pass-through on translated ids.** The open
  model proxy keys shaping by the pool `def.model`; the mapped catalog id does
  not match, so the deepseek turn rides the pass-through default (the same
  full-catalog trade-off #431 recorded).
- **v1 not live-tested** (host carries only v2.0.10); v1 emission is unchanged
  and pinned by the v1 unit cases.
- **The catalog source is the runtime's, not models.dev's live list.** Live
  models.dev carries all four pool ids; opencode v2.0.10's runtime catalogs do
  not. The mapping follows the binary's runtime behavior, not the live catalog.
