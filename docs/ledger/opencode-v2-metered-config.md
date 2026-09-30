<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### OpenCode v2 metered (hub-proxy) lane: v2-valid provider config (landed) (2026-09-30)

**Source:** operator escalation "Fix the OpenCode v2 metered (hub-proxy)
lane"; GitHub issue #284.

**Symptom as reported.** `WORKFLOW_ACP_OPENCODE_METERED=1 node --import tsx
--test test/acp-opencode-metered-probe.test.ts` on opencode v2.0.10:
initialize OK, newSession OK, the prompt times out (`probe_timeout`) with
`proxy.metrics()` requests 0 / usageEvents 0 / tokens 0 and empty agent
stderr.

**Live reproduction on this host (2026-09-30).** Reproduced before any change:
the prompt did NOT time out here — it returned `stopReason: "end_turn"` with
real (non-zero) token usage, the workspace command ran, and the proxy still
saw ZERO requests. The newSession model picker exposed ONLY the built-in
`opencode/*` provider (`currentValue: "opencode/nemotron-3.5-lightning-free"`;
61 `opencode/*` models). v2 ships a credential-free built-in provider, so the
turn completed on that model — masking the failure (the reported timeout is
the same defect on a host where the built-in free model is unavailable).

**Root cause (verified live, v2.0.10).** `meteredOpencodeConfig` emitted the
v1 provider shape (`provider: { "workflow-metered": { npm, options, models } }`)
plus top-level `model`. On v2 this config is parsed into `/api/config` but the
provider is never REGISTERED:

1. v2 changed the provider schema to top-level `providers` (plural) with
   `package` (e.g. `@opencode/ai/providers/openai-compatible`) and `settings`
   (v2 docs, `/v2/docs/providers`). The legacy `provider`/`npm`/`options` is
   auto-translated (`npm: "@ai-sdk/openai-compatible"` ->
   `package: "aisdk:@ai-sdk/openai-compatible"`), so it parses — but it still
   does not register.
2. v2 registers credential-activated providers only. A config-defined CUSTOM
   provider is parsed (`/api/config` lists it) but never enters the model
   catalog nor the ACP model picker, on v2.0.10, under every activation form
   tested: `settings.apiKey`, `env: [...]` + the env var, an
   `auth.json` (`{"workflow-metered":{"type":"api","key":"workflow-metered"}}`)
   entry, and `canonical: "openrouter"` — each left the picker at `opencode/*`
   only, and `session/set_config_option` on the custom ref failed
   `"model not found"`. (The migration spec §10 risk row already recorded
   `/api/provider` "follows credential activation"; this lands the ACP half.)
3. v2's `/api/model/default` ignores the config `model` (migration spec §10),
   so the session defaulted to the built-in `opencode/*` model — the direct
   cause of zero proxy traffic.
4. Overriding the BUILT-IN `openrouter` provider (`providers.openrouter.
   settings.baseURL` = proxy) and activating it with `OPENROUTER_API_KEY`
   (placeholder) DOES register: the ACP picker then lists the full
   `openrouter/*` catalog and `session/set_config_option("model",
   "openrouter/openrouter/auto")` succeeds.
5. Independent account-policy finding: bare `openrouter/auto` + tool schemas
   returns a `404 "No models match your request and model restrictions"` from
   OpenRouter on this operator key (and on the operator's own auth key). The
   production proxy composes `autoLatest` (`allowed_models` injection); the
   probe did not. With `autoLatest` the auto route resolves and meters.

**The fix (version-aware; v1 unchanged by construction).**

- `src/integrations/opencode-agent-config.ts` — new
  `opencodeMajor?: number` option (absent => v1). v2 emits
  `providers: { openrouter: { settings: { baseURL: "<proxy>/api/v1" } }, ... }`
  and model ref `openrouter/<model>`; v1 keeps the historical
  `provider`/`npm`/`options` shape byte-for-byte. New exports
  `OPENCODE_V2_METERED_ENV_KEY = "OPENROUTER_API_KEY"` and
  `OPENCODE_V2_METERED_PROVIDER_ID = "openrouter"` (lines 42/44). The v2
  config file stays credential-free — the placeholder never enters it.
- `src/integrations/acp-session.ts` — new `selectModel` option; `connect()`
  pins it on the freshly created session via
  `session/set_config_option(configId "model")`, because v2 ignores the config
  `model` for the default (lines 94/145/191/351-356).
- `src/integrations/acp-runtime.ts` — resolve the binary + major BEFORE
  writing the config, pass `opencodeMajor`, set the placeholder
  `OPENROUTER_API_KEY` env only on v2, and pass `selectModel` only on v2
  (lines 28/339/403/420).
- `test/acp-opencode-metered-probe.test.ts` — version-aware: resolves the
  major, composes `autoLatest` on the proxy (matching production), sets the v2
  env placeholder, and pins the config `model` on v2.
- `test/opencode-v2-metered-config.test.ts` (new) — pins the v1 shape
  (unchanged) and the v2 shape (built-in openrouter reuse, no placeholder in
  the file, vendor-provider v2 declaration).

**LIVE green evidence (verbatim; v2.0.10, 2026-09-30).**

`WORKFLOW_ACP_OPENCODE_METERED=1 node --import tsx --test
test/acp-opencode-metered-probe.test.ts`:

```
{
  "agent": { "name": "OpenCode", "version": "2.0.10" },
  "metering": "hub-proxy",
  "agentCredential": "placeholder-only",
  "model": "openrouter/openrouter/auto",
  "prompt": {
    "stopReason": "end_turn",
    "usage": { "inputTokens": 78, "outputTokens": 35, "totalTokens": 6385, "cachedReadTokens": 6272 }
  },
  "metrics": {
    "requests": 4, "usageEvents": 4,
    "promptTokens": 22316, "completionTokens": 293, "totalTokens": 22609,
    "costUsd": 0.0029494319999999997, "latestPromptTokens": 6350,
    "cacheReadTokens": 0, "cacheCreateTokens": 0
  },
  "workspaceContent": "before\\nmetered\\n"
}
ok 1 - OpenCode ACP metered proxy proves key-free agent env, working turns, and per-session usage metrics
# tests 1 / # pass 1 / # fail 0
```

**Non-metered regression (v2.0.10).** `WORKFLOW_ACP_REAL=1 node --import tsx
--test test/acp-real-probe.test.ts`: `# tests 2 / # pass 2 / # fail 0`
(opencode arm `end_turn`; ambient cline 3.0.62 arm `end_turn`).

**Verification hygiene.** `npm run lint` exit 0; `npm run typecheck` exit 0
(unpiped); `test/opencode-open-source-config.test.ts`,
`test/acp-runtime-agent.test.ts`, `test/auto-compact-config.test.ts`,
`test/pretrust-parsing-audit.test.ts` 18/18; new
`test/opencode-v2-metered-config.test.ts` 5/5.

**Residuals (stated honestly).**

- **v1 not live-tested.** The host carries only opencode v2.0.10. v1 behavior
  is unchanged by construction (same code path when `opencodeMajor` is absent
  or < 2) and pinned by the v1-shape unit test, but a live v1 re-run was not
  possible.
- **v2 server/topology lane unchanged.** `opencode-server-runtime.ts` still
  emits the v1-shape config; its metered-provider registration on v2 is
  probe-pending (out of scope here). The ACP lane is the one fixed and proven.
- **v2 open-source vendor providers (W070a) probe-pending.** They are declared
  in the v2 `package`/`settings` shape, but a config-defined custom provider
  is not registered into the v2 ACP picker, so the vendor lane is not usable
  on v2 until that upstream behavior is resolved. The metered OpenRouter lane
  is unaffected.
- **v2 `permission` spelling unprobed here.** The composed `permission`
  object is the v1 spelling; v2 docs show a `permissions` array. The hub
  authority projection onto v2 was not exercised by this probe (the probe
  auto-approves) and stays pre-existing probe debt.
- **The probe now composes `autoLatest`** to match production (bare
  `openrouter/auto` + tools 404s on the operator account policy). This is a
  probe-fidelity change, not a v1 config change.
