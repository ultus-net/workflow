# Goose ACP Implementation Map

**Status:** research record, read-only pass — 2026-09-18.
**Source:** `/var/home/hunter/goose` (shallow clone of
`https://github.com/aaif-goose/goose`), HEAD `1e83e89`, workspace version
`1.51.0`, ACP crates patched to rust-sdk rev `c97a5203d3392f7f231514d84eea014f9f43e6fb`.
**Purpose:** the authoritative map of goose's Agent Client Protocol surface used
by Workflow's `goose` agent kind (`WORKFLOW_ACP_AGENT=goose`) and by the W048
probe family. Every claim cites the goose source line it was read from.

> This is a dated record. Re-run the pass on every goose version bump (weekly
> release cadence); record supersessions here rather than rewriting history.

## 1. Entry point and transport

- **CLI subcommand:** `goose acp` — `crates/goose-cli/src/cli.rs:830` (flags
  `--with-builtin <NAME,...>`, `--enable-scheduler`), dispatched at
  `cli.rs:2804` to `goose::acp::server::run`.
- **Stdio server:** newline-delimited JSON-RPC over stdin/stdout —
  `crates/goose/src/acp/server.rs:2707` (`run`) builds the agent and calls
  `serve` (`server.rs:2652`). This is the transport Workflow uses.
- **Remote transport (not used by Workflow):** HTTP/WebSocket at `/acp`
  (`crates/goose/src/acp/transport/mod.rs:101`), bearer token via `X-Secret-Key`
  header or `?token=` query with constant-time compare
  (`transport/auth.rs:9,15,31`), TLS via `GOOSE_TLS_CERT_PATH`/`KEY_PATH`
  (`transport/tls.rs:84`), origin allowlisting (`transport/mod.rs:21-108`).
- **Default builtins:** `developer` when `--with-builtin` is absent
  (`server.rs:286`).

## 2. Standard ACP surface (`crates/goose/src/acp/server/dispatch.rs`)

| ACP request | Handler | Ref |
|---|---|---|
| `initialize` (inline) | `on_initialize` | `dispatch.rs:31`; `server.rs:1789` |
| `authenticate` | returns empty response | `dispatch.rs:37` |
| `session/new` | `on_new_session` | `dispatch.rs:43`; `server/new_session.rs:36` |
| `session/load` | `on_load_session` | `dispatch.rs:80`; `server/load_session.rs:382` |
| `session/prompt` | `on_prompt` | `dispatch.rs:124`; `server.rs:2263` |
| `session/cancel` (notification) | `on_cancel` | `dispatch.rs:143`; `server.rs:2412` |
| `session/set_config_option` | provider/mode/model/thinking_effort | `dispatch.rs:150` |
| `session/set_mode` | emits `CurrentModeUpdate` then responds | `dispatch.rs:359` |
| `session/list` | `on_list_sessions` | `dispatch.rs:389`; `server/list_sessions.rs:175` |
| `session/delete` | `on_delete_session` | `dispatch.rs:404`; `server/manage_sessions.rs:98` |
| `session/close` | `on_close_session` | `dispatch.rs:419`; `server.rs:2622` |
| `session/fork` | `on_fork_session` | `dispatch.rs:434`; `server/fork_session.rs` |
| anything else | `dispatch_custom_request` (`_goose/*`) | `dispatch.rs:472` (call at `:481`) |

`initialize` runs inline so connection-scoped capabilities land before a
pipelined `session/new` (`dispatch.rs:27-35`). `session/new`, `load`, and `fork`
send session-setup notifications after the response (`dispatch.rs:52,89,444`).

## 3. Initialize handshake and capabilities (`server.rs:1789-1848`)

Reads from the client on `initialize`:
- `client_capabilities.fs` → `client_fs_capabilities` (`:1795`).
- `client_capabilities.terminal` → `client_terminal` (`:1798`).
- `client_capabilities._meta.goose` (Rust field `meta`) → goose client caps
  (`:1799`; extraction `server.rs:452`; deserialization reads `_meta` because
  the ACP wire reserves it — `ClientCapabilities._meta`,
  `@agentclientprotocol/sdk` `schema/types.gen.d.ts:4256`).
- `_meta.goose/useLoginShellPath` (`:1821`), ACP form-elicitation support
  (`:1818`).

Advertised (`server.rs:1825-1847`):
- `load_session(true)`; `session` capabilities `list`, `delete`, `close`.
- `prompt_capabilities`: `image(true)`, `audio(false)`, `embedded_context(true)`.
- `mcp_capabilities.http(true)`.
- `_meta.goose`: `recipeParameterScopes` always, `localInference` when enabled
  (`server.rs:367`).
- `agentInfo` = `Implementation::new("goose", CARGO_PKG_VERSION)`.
- Auth method `goose-provider` / "Configure Provider".
- Response echoes the requested `protocolVersion`.

**Client opt-ins goose honors** (`server.rs:434-444`): `customNotifications`,
`mcpHostCapabilities`, `recipeParameterRequests`, `toolCallLabelEnrichment`.
`customNotifications` gates the entire `_goose/unstable/session/update` custom
channel (`server.rs:1805`, `863`, `2082-2114`; usage gating
`response_builder.rs:488-503`).

## 4. Permission requests

- Option set built from `PermissionOptionKind::{AllowAlways, AllowOnce,
  RejectOnce, RejectAlways}` (`server.rs:1581-1593`); sent as
  `RequestPermissionRequest`, response applied as a tool confirmation
  (`server.rs:1600-1626`).
- Mapping to goose permissions with fallbacks (`AllowAlways→AllowOnce`,
  `RejectAlways→RejectOnce`, etc.): `crates/goose/src/acp/common.rs:55-105`;
  unit-pinned at `common.rs:111-238`.
- Denials are honored; a malformed/absent decision maps through the same
  fail-closed path.

## 5. Session lifecycle

- **`session/new`** (`server/new_session.rs:36`): validates an absolute cwd
  (`:44`); reads `_meta` — `hidden`/`client` session type (`:281`),
  `sessionTitle`, `projectId` (`:315-319`), `enabledExtensions` (`:330`),
  `recipeParameterScopeId` (`:136`), `provider` (`:198`). Provider/model
  precedence recipe > `_meta.provider` > global default (`:187-221`). Response
  carries modes + config options + `_meta` (recipe, userRecipeValues,
  extensionResults, workingDir) (`:253-270`).
- **`session/load`** (`server/load_session.rs:382`): replays the transcript as
  `session/update` notifications (message chunks, thought chunks, tool calls,
  usage) with an optional `_meta.replayTail` window snapped to turn boundaries so
  tool pairs never split (`:91-124`, `:108-218`); resumes the saved provider
  session (`server.rs:203`); re-sends pending tool confirmations (`:221`).
- **`session/fork`** (`server/fork_session.rs`), **`session/list`**
  (`server/list_sessions.rs:175`), **`session/delete`**
  (`server/manage_sessions.rs:98`), **`session/close`** (`server.rs:2622`).
- Visible session types filter: `User`, `Scheduled`, `Acp` (`server.rs:143`).

## 6. Prompt → turn mapping and stop/error semantics

- `session/prompt` (`server.rs:2263`): the ACP `session_id` is the thread id;
  generates `run_<uuid>` + cancellation token, claims one active run per session
  (`:2271-2294`), converts prompt content (text/image/embedded text/resource
  link; audio ignored) (`:1321-1359`), calls `agent.reply(...)`
  (`:2316-2333`), then returns `PromptResponse` with `StopReason`.
- **Stop reasons:** `EndTurn` / `Cancelled` / `MaxTokens`
  (`server.rs:735-743`). Cancellation precedence is unit-pinned
  (`server.rs:3447-3449`).
- **Errors:** typed auth failures map to ACP `auth_required` (`server.rs:183`,
  `crates/goose/src/acp/mod.rs:37`); exhausted credits map to a custom `-32603`
  with `data.reason = "credits_exhausted"` (`server.rs:1655-1709`, constant
  `acp/mod.rs:22`).
- Optional unrolled agent loop from `_meta.goose.unrolledAgentLoop` or
  `GOOSE_STATE_MACHINE` (`server.rs:421`).

## 7. Usage / context channels

- `build_usage_updates` (`server.rs:765-800`) constructs a **custom**
  `GooseSessionNotification::UsageUpdate` (`used`, `context_limit`,
  `accumulated_{input,output}_tokens`, `accumulated_cost`) **and** a **standard**
  ACP `UsageUpdate` (with `Cost` when known).
- The standard update is always sent; the custom one is sent only when
  `clientCapabilities._meta.goose.customNotifications` was advertised
  (`response_builder.rs:488-503`, `server.rs:2082-2114`).
- Custom session update kinds: `usage_update`, `status_message`,
  `message_usage`, `live_voice_interaction_ended`
  (`crates/goose-sdk-types/src/custom_notifications.rs:22-38`).

## 8. Tool-call projection, notifications, fs/terminal delegation

- `ToolCallNotifier` emits `SessionUpdate::ToolCall` / `ToolCallUpdate`
  (`crates/goose/src/acp/tool_call_notifier.rs:12-38`).
- Projection: `crates/goose/src/acp/server/tool_calls/conversion.rs`
  (`build_initial_tool_call:94`, `goose_tool_call_meta:66`,
  `extract_tool_locations_from_{request,response}`, `build_tool_call_content`,
  `tool_call_update_fields_from_response`); `_meta.goose` carries message/tool
  names, output-limit flag, chain summary; live tool events project into
  `_meta.toolNotification` (`server/tool_notifications.rs:31-69`).
- **fs/terminal delegation:** when the client advertises `fs`/`terminal`,
  goose replaces the `developer` extension with an ACP-backed `AcpTools` client
  (`server.rs:1081-1141`) routing to client `fs/read_text_file`,
  `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`
  (`crates/goose/src/acp/fs.rs:66-447`). **Without those capabilities, goose
  keeps its builtin tools and still routes every mutation through
  `session/request_permission`** — which is what Workflow's W048 PERMISSION
  probe proved.
- Tool listing/calling custom methods: `server/tools.rs` (`on_get_tools:9`,
  `on_call_tool:60`; app tool calls require `auto` mode `:98`).

## 9. Config options, modes, models, providers

- Config option ids: `provider`, `mode`, `model`, `thinking_effort`
  (`crates/goose/src/acp/response_builder.rs:278-331`).
- Modes: `auto|approve|smart_approve|chat`
  (`response_builder.rs:217-234`); `GOOSE_MODE` default (`server.rs:963`).
- Model/provider resolution: env `GOOSE_PROVIDER`/`GOOSE_MODEL` then config
  (`crates/goose/src/config/providers.rs:65-87`); switching via
  `server.rs:2431-2612`. Provider inventory refresh is dispatched in
  `dispatch.rs:218-351`.
- Provider-host/key vars are **provider-specific** (`OPENAI_HOST`,
  `OPENROUTER_HOST`, `ANTHROPIC_HOST`, …). **`GOOSE_PROVIDER__HOST` /
  `GOOSE_PROVIDER__API_KEY` are documentation-only — no code reads them in this
  checkout** (`documentation/docs/guides/environment-variables.md` only). This
  is why Workflow composes `OPENROUTER_HOST` + placeholder key for the metered
  proxy path (`src/integrations/goose-agent-config.ts`).

## 10. MCP / extensions integration

- Per-session request `mcpServers` accepted on `session/new`
  (`server/new_session.rs:156`) and `session/load` (`load_session.rs:404`);
  `mcp_server_to_extension_config` (`server.rs:489-543`) supports `Stdio` and
  `StreamableHttp`, **rejects SSE** (`server.rs:528`).
- Extension merge order (`initial_session_extensions`, `server.rs:575-605`):
  builtins → recipe/`_meta.enabledExtensions` → configured enabled extensions →
  plugin MCP servers → request `mcpServers`.
- Config-file `extensions:` map schema:
  `crates/goose/src/config/extensions.rs:13,43-96` — the schema Workflow's
  `gooseConfigYaml` composes (skills-mcp stdio mount; W048 MOUNT probe green).
- Plugin MCP servers: `crates/goose/src/plugins/mcp_servers.rs`; hooks:
  `crates/goose/src/hooks/mod.rs` (`hooks/hooks.json`, blocking tool hooks
  `:703-834`).

## 11. Custom method catalog (canonical: `crates/goose/acp-schema.json`)

**114 methods total** (113 agent-side, 1 agent→client request); 111 handler
impls under `server/custom_dispatch.rs` (`#[custom_method(...)]`), routed via
`dispatch_custom_request`. Grouped:

- **Session:** extensions add/list/remove, working-dir/update,
  system-prompt/set, steer, live-voice availability/start/stop, info,
  conversation/truncate, project/update, rename, archive/unarchive, export/import,
  share/nostr.
- **Tools/resources/apps:** tools/list, tools/permissions/set, tools/call,
  resources/read, apps list/export/import/delete.
- **Config/preferences/defaults:** prompts CRUD, extensions CRUD/set-enabled,
  preferences read/save, config read/upsert/remove/read-all, defaults
  read/save/clear.
- **Providers:** list, supported-models, catalog list/template, setup catalog,
  custom create/read/update/delete, inventory refresh, readiness check, config
  read/status/save/delete/authenticate, secrets list/delete, canonical-model-info.
- **Recipes/schedules/sources/slash-commands/agent-mentions/onboarding/
  diagnostics/dictation/local-inference.**
- **Agent→client request:** `_goose/unstable/session/recipe/request-params`
  (`crates/goose-sdk-types/src/custom_requests/recipe.rs:13`).
- **Notifications:** `_goose/unstable/session/update`,
  `_goose/unstable/providers/authentication/device-code`
  (`custom_notifications.rs:9,58`).

The generated TS registry `ui/goose-acp-client/src/generated/index.ts` mirrors
the catalog; `crates/goose/acp-schema.json` is canonical.

## 12. goose as an ACP client (`crates/goose/src/acp/provider.rs`)

goose can itself drive an external ACP agent: `spawn_acp_process` (`:1480`)
with `AcpProviderConfig` command/args/env/work_dir/mcp_servers;
`initialize` with `ProtocolVersion::V1` + client capabilities (`:1539`); eager
session creation on connect (`:420-438`); permission handling (`:1386-1416`);
`AcpUpdate` projection (`:142-163`). Relevant to Workflow only if Workflow ever
adopts goose as a delegation host; not used by the `goose` agent kind.

## 13. Tests as executable spec

| File | tests |
|---|---|
| `crates/goose/tests/acp_server_test.rs` | 55 |
| `crates/goose/tests/acp_transport_auth_test.rs` | 35 |
| `crates/goose/tests/acp_provider_test.rs` | 22 |
| `crates/goose/tests/acp_custom_requests_test.rs` | 21 |
| `crates/goose/tests/acp_bootstrap_effort_test.rs` | 3 |
| `crates/goose/tests/acp_fork_session_test.rs` | 2 |
| `crates/goose/tests/acp_custom_provider_methods_test.rs` | 1 |
| `crates/goose/tests/acp_secret_cache_invalidation_test.rs` | 1 |

Shared behavioral cases are implemented once in
`crates/goose/tests/acp_common_tests/mod.rs` and instantiated for goose-as-server
and goose-as-client. `acp_fixtures/server.rs:116-133` pins the raw `initialize`
frame (`protocolVersion: 1`, `clientCapabilities: {}`); `:347-376` asserts V1
negotiation, agent name `"goose"`, and `session/delete` advertisement. There is
also a root Python stdio smoke client (`test_acp_client.py`).

## 14. Version pins

- Workspace `1.51.0`, `rust-version 1.94.1` (`Cargo.toml:11-12`).
- `agent-client-protocol-schema = "=1.5.0"` (`:24`);
  `agent-client-protocol` / `-http = "2.0.0"` (`:25-26`) **patched to rust-sdk
  git rev `c97a5203d3392f7f231514d84eea014f9f43e6fb`** (`:118-119`).
- TS clients `@aaif/goose-acp` / `@aaif/goose-acp-client` `1.51.0`, peer
  `@agentclientprotocol/sdk ^1.3.0`.
- **Version-sensitive:** the custom `_meta.goose` capability shape and the
  custom-notification gating come from the patched rust-sdk; re-verify on every
  goose bump alongside the W048 probe family.

## 15. Compatibility notes for Workflow's `goose` agent kind

- **Handshake:** Workflow's ACP client sends `initialize` with
  `clientCapabilities.session.configOptions.boolean`. Advertising
  `_meta.goose.customNotifications` — the opt-in goose reads at
  `server.rs:1805` for its custom usage/status channel — is added by the
  goose-web-agent change (PR #35, `acpClientCapabilities()` in
  `src/adapters/acp-subprocess.ts`); on `main` before that change the client
  advertises only `configOptions`, so goose's custom channel is not explicitly
  opted into even though W048 observed usage projection on 1.50.1.
- **Permissions:** Workflow authors `allow_once`/`reject_once`-class decisions
  through goose's option set (`common.rs`), proven live by the W048 PERMISSION
  probe.
- **fs/terminal:** Workflow does **not** advertise `fs`/`terminal`, so goose uses
  its builtin tools and permission-gates each mutation. Advertising them would
  route goose file ops through the hub `AcpFsServer` instead — a deliberate
  future choice, not required for enforcement (request_permission interception is
  already proven).
- **MCP:** Workflow delivers skills via a hub-written `config.yaml` `extensions:`
  map under `GOOSE_PATH_ROOT` (W048 MOUNT green). Per-session `mcpServers` on
  `session/new` is an alternative channel goose supports (`new_session.rs:156`).
- **Resume:** `session/load` + `_meta.replayTail` is the resume mechanism;
  Workflow relies on the workspace-keyed `GOOSE_PATH_ROOT` so the store survives
  restarts (`gooseWorkspaceConfigTag`).

## 16. Honest uncertainties

- This is a shallow, read-only pass; no goose build/tests were run here. Behavior
  claims are source-derived and cross-checked against Workflow's live W048 probe
  verdicts where they overlap.
- The `_meta` vs `meta` wire key is inferred from the ACP schema reserved field
  plus goose's Rust accessor; the W048 METERED evidence observed usage projection
  on 1.50.1, so the opt-in makes an already-observed channel explicit rather than
  newly enabling it (see `docs/FEATURES.md` goose row).
- The provider-credential env vars are provider-specific and version-sensitive;
  pin them per provider when composing new workloads.
