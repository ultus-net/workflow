# W050 execution plan — retire the vendored-Cline SDK runtime, retain the ACP connector

**Status:** draft plan, 2026-09-18 (revised 2026-09-18: retain the ACP
connector). **Gate:** do not execute until W050 criterion 1 (backup-slot
takeover) and criterion 2 (SDK-seam decision) have resolved. The criterion-2
draft currently lives on branch `feat/w050-sdk-seam-decision` (PR #37) as
`docs/ACP_DECISION.md` "W050 SDK-seam decision — PROPOSED"; it is not yet on
`main`. This plan removes nothing by itself.

**Execution status (2026-09-18):** steps C1-C4, 5, and 6 executed on branch `feat/w050-cline-removal`; docs step 7 in progress; operator gate criteria 1-2 still open.

## Operator scope decision (2026-09-18)

**Retain the Cline ACP connector; remove only the vendored SDK/plugin runtime
and the vendored checkout.** Rationale: the ACP connector is thin and
agent-agnostic (it reuses the generic ACP client), so it is cheap insurance if
Cline is re-adopted later; the vendored SDK/plugin path, the patched checkout,
and the pinned patch are the costly, load-bearing-to-maintain parts. Consequence:
this W050 is a *partial* retirement — `WORKFLOW_ACP_AGENT=cline` and
`workflow-tui --driver cline` stay selectable, backed by a stock `cline --acp`
binary rather than the vendored patched build.

## Why a plan first

The removal still touches shared substrates physically entangled with the Cline
modules (types in `cline-tui-bridge.ts`; the upstream metering key named after
Cline) and must untangle them *before* deletion or the remaining ACP surfaces
break.

## Gate checklist

1. W050 criterion 1: the operator's W049 daily-driver period holds, so goose
   demonstrably covers the fallback/insurance role (TASKS.md W050).
2. W050 criterion 2: the SDK-seam accepted-risk is signed (PR #37), or a live
   Cline-side subagent-internal proof lands and the seam is retained instead.
   Retaining the ACP connector does not depend on the SDK/plugin seam.
3. Operator direction to land a removal PR (repo rule: Cline removal is
   evidence-gated, never date-gated).

## A. RETAIN — the Cline ACP connector (dormant, selectable)

Keep in place:

- `"cline"` in `AcpAgentKind` and the `createClineRuntime` branch
  (`src/integrations/acp-runtime.ts:47,63,252`), including its per-runtime
  metering-proxy wiring.
- `src/integrations/cline-launch.ts` (`resolveClineLaunch`,
  `globalClineEntrypoint`, `WORKFLOW_CLINE_BIN`) — but **re-point it away from
  the vendored checkout**: it must resolve an ambient `cline` on `PATH` (or the
  env override), since `.workflow-cline/` is removed. Document the `command`
  (`cline --acp`) and required env (`CLINE_API_KEY`, `CLINE_PROVIDER`,
  `CLINE_MODEL`).
- The generic ACP path the connector reuses: `src/adapters/acp*.ts`,
  `src/integrations/acp-session.ts`, `acp-contained-agent.ts`.
- `"cline"` in `DRIVER_NAMES` (`src/cli/driver-registry.ts:12`) and the cline
  composer; the `cline` entry in `src/ui/web-agents.ts`.
- The connector's tests/probes: `test/acp-cline-*.test.ts` (10),
  `test/cline-launch.test.ts`, `test/cline-probe-helpers.ts` — kept so the
  retained connector stays probe-qualified per ambient version.
- `docs/HOST_ADAPTERS.md` Cline ACP rows — retained with a dated
  "dormant connector, stock-only" note.

## B. REMOVE — vendored SDK/plugin runtime, checkout, patch

Delete:

- SDK host adapter: `src/adapters/cline.ts`.
- SDK integration: `src/integrations/cline-plugin.ts`, `cline-runtime.ts`,
  `cline-session.ts`, `cline-shell-executor.ts`, `cline-tui-bridge.ts` (after
  step C1), and `src/cli/mcp-settings.ts` (verify orphaned — see C3).
- Build/patch: `scripts/build-cline-tui.mjs`, `scripts/bump-cline-tag.mjs`,
  `patches/cline-cli-v3.0.61-workflow.patch`.
- Vendored checkout: `.workflow-cline/` (untracked; remove the directory and
  the `.gitignore:4` / `.git/info/exclude:9` entries).
- SDK/plugin tests: `test/cline-adapter.test.ts`, `test/cline-plugin.test.ts`,
  `test/cline-session.test.ts`, `test/cline-tui-bridge.test.ts`,
  `test/integration/cline-coding-session.mjs`,
  `test/integration/cline-plugin-fixture.mjs`,
  `test/integration/cline-resume.mjs`,
  `test/integration/cline-runtime.mjs`.
- Non-Cline-named tests to **edit, not delete**: `test/driver-registry.test.ts`
  (drop only the SDK cases; the ACP `cline` driver stays),
  `test/tui-cli.test.ts:9,19`, `test/toolbox-mcp-settings.test.ts` (with C3),
  `test/interactive-containment-cli.test.ts` (ClineHostAdapter wiring).

Edit (not delete) live importers of the *removed SDK* modules:

- `src/cli/ink-tui.tsx:7,136-138`, `src/cli/style-eval.ts:4,35`
  (`createConfiguredClineRuntime` — re-point at the ACP runtime or drop),
  `src/cli/contained-shell.ts:7,37` (`ClineHostAdapter` — the SDK adapter;
  re-point at the ACP/guard path or drop).
- `src/index.ts` — drop the re-exports of the removed modules:
  `./adapters/cline.js` (line 9), `./integrations/cline-plugin.js` (7),
  `./integrations/cline-shell-executor.js` (8), `./integrations/cline-session.js`
  (16), `./integrations/cline-runtime.js` (17). **Keep** any `cline-launch`
  export still used by the ACP connector. This is the package's public
  compatibility boundary.
- `package.json` — remove `tui:cline:build`, `build:cline-agent`, `cline:bump`,
  `test:cline-runtime`, `test:cline-coding-session`, `test:cline-resume`;
  replace `pretest` (currently the Cline build).
- `scripts/install.mjs`, `scripts/prepare-tool.mjs` — remove the Cline build
  steps.
- `packaging/workflow-web.service` — remove the `ExecStartPre` Cline build.

## C. Shared substrates — untangle before deleting

1. **Shared types live in `cline-tui-bridge.ts`.** General modules import
   `WorkflowRunController` / `WorkflowApplicationResolver` from it
   (`src/integrations/workflow-hub.ts:8-14`, `hub-scheduler.ts:4`,
   `run-registry.ts:8`, `hub-reviewer.ts:21`), and **`shellExecutorFor` is not
   Cline-only** — `src/cli/hub.ts:9,101` uses it. Relocate the still-consumed
   exports to a neutral module (e.g. `src/integrations/run-controller.ts`) and
   re-point every consumer before deleting the bridge.
   `WorkflowClineTuiBridge` and `recordClineTeamTaskEnvironmentEvidence` are
   Cline-only and go.
2. **`CLINE_API_KEY` / `~/.config/workflow/cline-api-key` is the shared
   upstream metering key for *all* ACP runtimes** (`acp-runtime.ts:461,609`),
   including the retained Cline connector and goose. Do **not** delete it.
   Introduce a canonical name (e.g. `WORKFLOW_UPSTREAM_KEY` +
   `~/.config/workflow/upstream-key`) with back-compat reads of the old names;
   the old names may be deprecated later, separately gated.
3. **`~/.workflow/cline_mcp_settings.json` + `src/cli/mcp-settings.ts`.** The
   only non-test consumer was the retired `src/cli/tui.tsx`; verify with
   `rg "mcp-settings|cline_mcp_settings" src test`, then retire it (or repurpose
   to a shared MCP settings path). `test/toolbox-mcp-settings.test.ts` goes.
4. **Genericize Cline-named comments/constants in shared modules** —
   `src/adapters/acp-contained-agent.ts:20`, `src/integrations/model-usage-proxy.ts:35`,
   `src/containment/linux-bwrap.ts`, `src/integrations/goose-agent-config.ts:99,118,143`,
   and the `hub*.ts` comments (e.g. `src/cli/hub.ts:83`).

## D. Cline ACP support — full look (2026-09-18)

Read-only pass over a fresh clone (`github.com/cline/cline`, HEAD `8872d81`,
`apps/cli` version **3.0.62**). All ACP code is `apps/cli/src/acp/`.

- **Entry/transport:** `cline --acp` (`apps/cli/src/commands/program.ts:64`) →
  `runAcpMode` (`acp/index.ts:9`); stdio ndJson via `@agentclientprotocol/sdk`
  `AgentSideConnection`; `--auto-approve true` sets the launch default
  (`program.ts:146-161`).
- **initialize** (`acp/acpAgent.ts:127`): `loadSession:true`;
  `promptCapabilities` image `true`, audio `false`, embeddedContext `false`;
  `agentInfo` from build info; auth methods are OAuth-only — `cline`,
  `cline-pass`, `openai-codex` (`acp/auth.ts:12`). **No API-key auth method is
  advertised.**
- **Auth/headless:** `isSessionReady` (`acpAgent.ts:151`) accepts
  `process.env.CLINE_API_KEY` even without `authenticate`, and
  `CLINE_PROVIDER` / `CLINE_MODEL` are read (`:190,201,765-766`). **So stock
  `cline --acp` + `CLINE_API_KEY` + `CLINE_PROVIDER` may now run headless** —
  this contradicts the older "stock 3.0.62 is account-cloud-only" finding and
  should be re-verified before relying on the vendored patch; it is a further
  argument for retaining the connector.
- **Permissions** (`acp/permissions.ts`): options `allow_once`, `allow_always`,
  `reject_once` (no `reject_always` presented; the response handler tolerates
  it, `:79-81`). Every tool call routes through `requestPermission` unless
  auto-approve; the agent emits a pending `tool_call_update` first (`:104-130`).
- **Auto-approve** (`acp/auto-approve.ts`): per-session boolean config option
  `auto_approve` + launch flag; default tool policies are
  `{ "*": { autoApprove: false } }` (`acpAgent.ts:786`).
- **Session lifecycle:** `newSession` (`:183`), `loadSession` (`:246`, replays
  history via `acp/session-load.ts`; `resourceNotFound` when no persisted
  conversation), `prompt` (`:325`, one abort controller per session; fatal
  errors surface as `auth_required`/internal → `toAcpPromptError` `:841`),
  `cancel` (`:402`), `setSessionMode` (`:418`), `unstable_setSessionModel`
  (`:435`), `setSessionConfigOption` (`:452`: provider/organization/model/mode/
  auto_approve).
- **Updates** (`acp/session-updates.ts`): agent message/thought chunks,
  `tool_call`/`tool_call_update`, `current_mode_update`, `config_option_update`,
  `session_info_update`. **`usage` and `iteration_*` events are dropped** — no
  `usage_update`, so no token/cost visibility over ACP (the hub metering proxy
  remains the only usage source).
- **Modes:** `plan` / `act` (`:167-181`), exposed as modes and a `mode` config.
- **Tool kinds** (`acp/tool-utils.ts:4-25`): `edit`/`execute`/`read`/`search`/
  …; **`spawn_agent` and `Agent` map to `"think"`** — spawn is projected as a
  non-mutating kind, so Workflow must not classify spawns by ACP kind (it
  already fail-closes unknown/high-blast-radius names).
- **No fs/terminal delegation:** the ACP layer is agent-side only; there are no
  client `fs/*`/`terminal/*` requests. Enforcement therefore requires whole-agent
  containment (as today).
- **MCP:** `newSession` accepts and stores `mcpServers` (`:208,273`) but
  `buildConfig` (`:761-809`) carries **no `mcpServers` field** — per-session MCP
  servers appear unwired in this version (consistent with the earlier
  `NO_MCP_TOOLS` finding).
- **Spawn config:** `enableSpawnAgent: true`, `enableAgentTeams: false`
  (`:787-788`).
- **Tests:** `acp/{auto-approve,index,organizations,session-load,session-updates}.test.ts`
  (no integration test for `acpAgent.ts` itself).

## E. Reference updates (docs + configuration)

- **Living docs — rewrite:** `docs/FEATURES.md` (supersede the vendored-SDK rows;
  add the retained-connector row), `docs/TUI_INTEGRATION.md`, `docs/HUB.md`,
  `docs/HUB_PROTOCOL.md`, `README.md`, `AGENTS.md`,
  `docs/GUARD_CORPUS_MAP.md`, `docs/OPENCODE_QUALIFICATION.md`,
  `docs/UI_INTEGRATION.md`.
- **Append-only dated records — supersession notes, never rewrite:**
  `docs/ACP_DECISION.md`, `docs/ACP_RESEARCH.md`, `docs/ACP_SURFACE.md`,
  `docs/HOST_ADAPTERS.md` (keep the Cline ACP rows, mark the connector dormant /
  stock-only; the SDK-probe rows get a dated note), `docs/GOOSE_RESEARCH.md`,
  `docs/GOOSE_DOGFOOD.md`, `docs/CHAT_UI_RESEARCH_2026.md`,
  `docs/TUTOR_AND_LEARNING_SPEC.md`.
- **`docs/SECURITY_ASSURANCE.md` — machine-checked.** Rows citing **removed SDK**
  tests (`test/cline-*`, the SDK/plugin `test/integration/cline-*.mjs`) must be
  removed or re-pointed; rows citing the **retained** `test/acp-cline-*` probes
  stay. Affected sections: **S2, S3, S6, S7, S12** (S4 cites none). The checker
  enforces per-section citation floors
  (`test/security-assurance.test.ts`), so a section losing rows must rebalance
  with real OpenCode/goose/ACP-Cline citations, never padding. Run it after
  editing.
- **Archive, do not silently drop:** the vendored-SDK plugin-era findings
  (OPENCODE_QUALIFICATION matrix, probe logs, the pinned patch rationale) are
  preserved in their dated records.

## F. Verification (on the removal diff)

- **Grep gate:** no references remain to the removed SDK modules
  (`cline-plugin`, `cline-session`, `cline-shell-executor`, `cline-tui-bridge`,
  `adapters/cline`), to `.workflow-cline`, or to the patched build; the **retained**
  connector still compiles and its `test/acp-cline-*` / `cline-launch` tests pass.
- **Full gates (release gate):** `npm test` (no Cline pretest), `npm run
  typecheck`, `npm run lint`, `npm run build`, `npm run toolbox:verify`.
- **ACP conformance:** `test/adapter-conformance.test.ts` and the OpenCode/goose
  families still pass/skip correctly; `workflow-tui --driver cline` still parses
  and resolves an ambient `cline` (document the requirement).
- **Security-assurance checker green** after citation rebalancing.
- Independent five-axis review before merge.

## G. Sequencing

1. Gate clears.
2. C1 relocate shared types + `shellExecutorFor` → verify.
3. C2 upstream-key canonicalization + back-compat → verify.
4. C3/C4 retire mcp-settings + genericize comments → verify.
5. A re-point `cline-launch` at the ambient binary; confirm the retained
   connector probes still pass against stock `cline` (or record them
   probe-pending).
6. B adjust live importers + index/package scripts; delete SDK modules, tests,
   patch, checkout, excludes; edit the shared tests.
7. E doc reconciliation + F verification.
8. Review + PR.

## H. Risks / unknowns

- **Retained-connector viability now depends on stock `cline`.** Removing the
  vendored patched build means the connector needs an ambient `cline` with
  working headless auth. Current 3.0.62 code suggests `CLINE_API_KEY` +
  `CLINE_PROVIDER` works, but that must be re-verified live; if it does not, the
  connector is retained but unusable until Cline ships API-key ACP auth (record
  it as a known dormant limitation, not a silent break).
- The security-assurance per-section citation floors are the most likely
  breakage; rebalance with real citations, never pad.
- The upstream-key rename touches a live operator credential path; ship it with
  back-compat.
- `src/index.ts` is the package's public export surface; dropping the SDK
  re-exports is the compatibility boundary to check (no external consumers
  known).
