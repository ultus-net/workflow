<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### OpenCode v2 metered lane: version-aware config for the server/topology lane (landed) (2026-09-30)

**Source:** the follow-up residual recorded by PR #427's review and ledger
(`docs/ledger/opencode-v2-metered-config.md`, "v2 server/topology lane
unchanged"): `src/integrations/opencode-server-runtime.ts` still wrote the v1
metered provider shape (no `opencodeMajor`), passed no v2 placeholder env, and
did no explicit model pin. GitHub issue #284.

**Premise under test (from #427).** The ACP lane needed three things on v2: the
`providers`/`package`/`settings` config shape (a config-defined custom provider
is not registered into the ACP model catalog), the placeholder `OPENROUTER_API_KEY`
env (the built-in `openrouter` provider is credential-activated), and an explicit
`session/set_config_option` model pin (v2 ignores the config `model` for the ACP
session default, migration spec §10). The task extended the same treatment to the
server/topology lane.

**Live findings on this host (opencode v2.0.10, 2026-09-30).** Three scratch
probes against the REAL `opencode serve` (not committed) resolved the server-lane
mechanics before implementation:

1. `opencode serve --help` (v2.0.10) lists `--hostname`, `--port`, `--cors`,
   `--service`, `--stdio`. `opencodeServerArgs(port)` = `["serve", "--hostname",
   "127.0.0.1", "--port", "<port>"]` is valid unchanged; no v1-only flag is
   emitted.
2. With the v2-shaped config (`providers.openrouter.settings.baseURL` = a local
   mock, `model: "openrouter/openrouter/auto"`, `OPENROUTER_API_KEY` placeholder),
   a session created via `POST /api/session` and prompted via
   `POST /api/session/{id}/prompt` ran on `providerID: "openrouter"` and the mock
   received `POST /api/v1/chat/completions` with `model: "openrouter/auto"`.
   **The server/HTTP lane HONORS the config `model`** for sessions created
   through the API — unlike the ACP session default. So the config `model` IS the
   server-lane pin; no `set_config_option`-style call is needed.
3. Dropping the config `model` (same v2 provider shape) produced ZERO proxy
   traffic — confirming the `model` field is what routes the session. The config
   model is also respected when overridden (`openrouter/anthropic/claude-sonnet-4`
   reached the mock verbatim).
4. **Honest correction to the premise's severity:** the legacy v1 custom-provider
   shape (`provider: { "workflow-metered": { npm, options, models } }` +
   `model: "workflow-metered/openrouter/auto"`) ALSO routed a v2 HTTP session
   through the mock on v2.0.10 (assistant `providerID: "workflow-metered"`). The
   v2 custom-provider non-registration #427 proved is ACP-catalog-specific; the
   HTTP session runtime auto-translated and used the v1 provider. The server lane
   was therefore NOT producing zero proxy traffic on API-created sessions. The
   v2-native shape is still the requested canonical route (consistency with the
   ACP lane, the documented v2 schema, and future-proofing against the
   custom-provider registration going away).

**The fix (version-aware; v1 unchanged by construction).**

- `src/integrations/opencode-server-runtime.ts`
  - New `opencodeServerLaunchEnvironment({ configDir, password, opencodeMajor })`
    (lines 131-144): the base launch env plus, on v2 only, the placeholder
    `OPENROUTER_API_KEY` = `METERED_PLACEHOLDER_KEY`. The bwrap backend launches
    with `--clearenv`, so no ambient provider key can leak and the
    placeholder-only posture holds (real key stays proxy-side).
  - `createOpencodeServerRuntime` now resolves the binary and probes
    `opencodeMajorVersion(opencode.executable)` BEFORE writing the config
    (lines 219-239), passes `opencodeMajor` to `meteredOpencodeConfig`, and uses
    `opencodeServerLaunchEnvironment` for the spawn env (line 271). v1
    (`opencodeMajor` absent) keeps the historical shape and env byte-for-byte.
  - The config `model` is documented in-code as the server-lane metered pin
    (lines 219-224), with the v2.0.10 live finding above.
- `test/opencode-v2-server-config.test.ts` (new, 5 tests): pins the v1 vs v2
  launch env (placeholder absent on v1, `METERED_PLACEHOLDER_KEY` on v2), the v2
  server config shape (built-in `openrouter` reuse, credential-free file, model
  ref), and the v2-valid `opencodeServerArgs`.
- `test/opencode-server-runtime.test.ts` and
  `test/opencode-server-attach-probe.test.ts` updated to assert the
  version-appropriate config shape on the ambient binary (v1 or v2).
- `test/opencode-server-metered-probe.test.ts` (new, gated
  `WORKFLOW_OPENCODE_SERVER_METERED=1`): the server-lane counterpart of
  `test/acp-opencode-metered-probe.test.ts`. It runs the REAL
  `createOpencodeServerRuntime` (cleared-environment boundary) with a real
  metering proxy + `autoLatest` (production fidelity), creates a session via the
  API, prompts, and asserts the proxy observed traffic.

**LIVE green evidence (verbatim; v2.0.10, 2026-09-30).**

`WORKFLOW_OPENCODE_SERVER_METERED=1 node --import tsx --test
test/opencode-server-metered-probe.test.ts`:

```
{
  "agent": "OpenCode",
  "version": "2.0.10",
  "lane": "server/topology",
  "agentCredential": "placeholder-only",
  "assistantModel": { "id": "openrouter/auto", "providerID": "openrouter" },
  "assistantText": "DONE",
  "metrics": {
    "requests": 1, "usageEvents": 1,
    "promptTokens": 6057, "completionTokens": 4, "totalTokens": 6061,
    "costUsd": 0.0018219, "latestPromptTokens": 6057,
    "cacheReadTokens": 0, "cacheCreateTokens": 0
  }
}
ok 1 - OpenCode server/topology metered proxy: v2 HTTP session routes through the hub proxy
# tests 1 / # pass 1 / # fail 0
```

No-regression probes run LIVE on v2.0.10 (all green):

- `WORKFLOW_OPENCODE_SERVER_ATTACH=1 test/opencode-server-attach-probe.test.ts`
  — `1/1` (runtime + gateway authority split against the real server;
  version-aware config assertion).
- `WORKFLOW_ACP_OPENCODE_METERED=1 test/acp-opencode-metered-probe.test.ts`
  — `1/1` (end_turn, requests 3 / usageEvents 2 / totalTokens 12318, workspace
  command ran) — the #427 lane is unregressed.
- `WORKFLOW_OPENCODE_AUTO_COMPACT_PROBE=1 test/opencode-auto-compact-probe.test.ts`
  — `2/2`. `WORKFLOW_OPENCODE_WEBUI_PROBE=1
  test/opencode-webui-gateway-probe.test.ts` — `1/1`.
  `WORKFLOW_OPENCODE_COMPACT_PROBE=1 test/opencode-compact-probe.test.ts` — `1/1`.

**Verification hygiene.** `npm run lint` exit 0; `npm run typecheck` exit 0
(unpiped). Focused suites: `opencode-v2-server-config` + `opencode-v2-metered-config`
+ `opencode-server-runtime` + `opencode-server-runtime-downgrade` +
`opencode-server-launcher` + `opencode-server-gateway-ingress-probe` +
`opencode-server-gateway` + `opencode-server-authority` = **84/84 pass, 0 fail,
0 skipped**; `opencode-v2-route-class` + `acp-runtime-agent` +
`auto-compact-config` + `opencode-open-source-config` +
`pretrust-parsing-audit` + `opencode-server-budget` + `opencode-server-monitor`
= **109/109 pass, 0 fail, 0 skipped**.

**Residuals (stated honestly).**

- **v1 not live-tested.** The host carries only opencode v2.0.10. v1 is
  unchanged by construction (same code path when `opencodeMajor` is absent or
  `< 2`) and pinned by the new unit/env tests, but a live v1 re-run was not
  possible.
- **The stock TUI's own model selection is NOT pinned by this change.**
  `POST /api/session` honors the config `model` when the client omits one, but
  the daemon's gateway proxies requests byte-transparently and does not rewrite
  an explicit client `model` ref. Whether the stock `opencode attach` TUI
  defaults to the config model or an explicit built-in `opencode/*` ref was not
  probed here (needs an interactive client); if it sends an explicit non-metered
  ref, a gateway-side create/switch-model injection would be the next step. The
  hub's own web surface creates sessions with no model, so it rides the config
  pin.
- **The v2 open-source vendor provider registration gap (W070a) stays open.**
  A config-defined custom provider is still not registered into the v2 ACP model
  catalog (the #427 residual); the metered OpenRouter route is the one proven on
  v2. This change does not affect it.
- **`/api/provider` lists no providers on the server lane** in the scratch
  probes (with or without the placeholder env), and `/api/model/default` returns
  `null`; the session route still resolves via the config `model`. The
  credential-activation/catalog visibility path remains the §10 open item.
- **v2 `permission` spelling unprobed here** (pre-existing probe debt; the
  composed `permission` object is the v1 spelling).
