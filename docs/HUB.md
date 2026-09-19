# Workflow Hub Design (Option A)

## Goal

Workflow is a control plane for coding-agent hosts, and the hub is its single
authority endpoint. Interactive TUI, headless CLI, zen, chat connectors,
scheduled agents, teams, and desktop all go through a single loopback hub that
Workflow owns. `workflow` stops being a launcher-side helper and becomes the
actual system authority; host SDKs remain replaceable adapters onto it.

## Architecture

```
Agent surfaces (OpenCode lead, goose backup, Cline fallback)
  │  hub endpoint: ws://127.0.0.1:<hubPort>  (Workflow-controlled)
  ▼
Workflow Hub (long-running daemon; npm bin `workflow-hub`)
  ├ Workflow authorization (today's loopback bridge, daemonized)
  ├ vendored toolbox MCP registrations (merged settings already exist)
  ├ containment / evidence authority over proposed actions
  ├ records task/evidence state in WorkflowApplication
  └ endpoint discovery file for hub clients (`readHubDiscovery(...)`)
```

The Workflow Hub is the *only* hub on the machine for this install. The
vendored Cline's `ensureCliHubServer` path is replaced: instead of spawning its
own detached hub, consumers (Cline today; any hub client tomorrow) connect to
the Workflow hub for everything. Note the current default surface — the browser
operator UI over stock-ACP OpenCode — runs its own in-process application
authority and does not require the hub daemon; the hub's dependent surfaces are
the Cline family and every launcher that resolves it.

## Daemon protocol

- **Transport**: loopback WebSocket (host 127.0.0.1, port from config), auth
  token issued at hub start and written to the discovery file.
- **Discovery file**: `<data-dir>/hub/discovery.json` created atomically —
  `{ hubId, endpoint, authToken }` so `readHubDiscovery` finds it.
- **Hook protocol**: same shape as today's workflow bridge — `POST /before-tool`
  for hook gating, `POST /bash` for executor routing. Specified as a
  versioned, SDK-neutral contract in `docs/HUB_PROTOCOL.md` (conformance:
  `test/hub-protocol.test.ts`).
- **Authority migration**: today's per-TUI-loopback bridge is promoted into
  the hub daemon; interactive/headless/zen/connectors keep working, cron
  starts covering too.

## Hook ↔ authority mapping

| Hook invoked hub-side | Workflow hub does |
|---|---|
| `beforeTool` | Workflow kernel authorize; consult `workflow-guard-mcp` for safety |
| `bash` executor | WorkflowContainedProcess (bubblewrap isolation, workspace limits) |
| every ClientContribution | Registered and validated by the hub daemon, with audit history |

All authority uses `WorkflowApplication` task/evidence state. Actions that
can't be authorized fail **closed** (hub denies rather than guessing).

## Model routing (open-source pool)

The default model pool is open-source-only. Direct vendor endpoints are
preferred; OpenRouter is the uniform fallback, and closed models remain
available through an explicit operator override (they are not deleted).

| Pool id | Vendor | OpenAI base URL | Anthropic base URL | Fallback (OpenRouter) |
|---|---|---|---|---|
| `deepseek-flash` | DeepSeek V4.1-Flash | `https://api.deepseek.com` | `https://api.deepseek.com/anthropic` | `deepseek/deepseek-v4.1-flash` |
| `glm-5.3` | GLM-5.3 | `https://api.z.ai/api/paas/v4` | `https://api.z.ai/api/anthropic` | `z-ai/glm-5.3` |
| `glm-5.3-flash` | GLM-5.3-Flash | `https://api.z.ai/api/paas/v4` | `https://api.z.ai/api/anthropic` | `z-ai/glm-5.3-flash` |
| `kimi-k3` | Kimi K3 | `https://api.moonshot.ai/v1` | `https://api.moonshot.ai/anthropic` | `moonshotai/kimi-k3` |

- **Composition.** Each keyed vendor gets its own loopback metering proxy. The
  agent config carries the placeholder credential and the proxy URL; the real
  vendor key lives only proxy-side (`loadOpenModelKeys`: env override first,
  then `~/.config/workflow/<family>-api-key`). The OpenAI chat wire is used for
  all three vendors — one wire discipline for the pool.
- **Request shaping.** `ModelProfile` (`src/integrations/model-profile.ts`)
  centralizes per-vendor params and `shapeRequestBody` applies them to
  chat-completion bodies at the vendor proxy: `reasoning_effort`
  `low`/`high`/`max` with task-class defaults (coding `high` for DeepSeek,
  `max` for GLM/K3; batch `low`), and the invariant that GLM/K3 are never sent
  `thinking.type: "disabled"` (GLM-5.3 rejects it).
- **Off-peak scheduling.** Batch/CI schedules may declare `offPeak`
  (`deepseek` | `glm`) and defer to the discounted window (GLM peak is
  Mon–Fri 14:00–18:00 SGT; DeepSeek's window is operator-supplied via
  `WORKFLOW_OFF_PEAK_DEEPSEEK_PEAK_UTC`). An unknown window fails open and is
  logged.
- **Closed-model override.** Set `WORKFLOW_OPENCODE_MODEL` to any model id
  (e.g. `openrouter/auto` or a closed frontier slug); the override rides the
  legacy metered provider and the open-source pool stays selectable.
  `WORKFLOW_OPEN_MODEL_POOL` selects an ordered subset of the pool by id.
- Live-verification evidence for every id/endpoint:
  `docs/superpowers/specs/2026-09-19-w070a-routing-live-verification.md`.

## Related surfaces (post-hub)

| Surface | Enforced via |
|---|---|
| Interactive TUI | direct hub client |
| Headless CLI (`workflow "..."`) | direct hub client |
| Zen | direct hub client |
| Connectors (Slack, Telegram, Discord, GChat, Linear, WhatsApp) | hub-side localRuntime hooks |
| **Scheduled agents** | hub-side cron with workflow-authorize hooks |
| Teams/desktop | hub-side localRuntime hooks |

The browser operator UI (OpenCode lead) and the ACP terminal surfaces
(`workflow-tui --driver acp|opencode`, goose) compose the application authority
in-process (`WorkflowApplication` + `createConfiguredAcpRuntime`, whole-agent
containment); they do not depend on the hub daemon. The hub remains the shared
authority for the Cline family and for launchers that resolve it.

## Commands

- `workflow-hub` — start the detached authority daemon (discovery + token).
- `workflow` — the browser operator UI launcher (OpenCode in ACP mode by
  default; opens the browser); `workflow-tui --driver acp|opencode` is the
  terminal surface, with the agent kind chosen by `WORKFLOW_ACP_AGENT`
  (`opencode` | `cline` | `goose`). Hub-resolving launchers (the Cline family)
  still connect to the global Workflow hub.
- Launchers that resolve the hub auto-spawn `workflow-hub` detached when the
  discovery file is missing or stale, guarded by
  `~/.workflow/hub/discovery.json.spawn.lock`. `WORKFLOW_AUTOHUB=0` restores
  strict fail-fast resolution.

For hub team tasks (the Cline `/team-task` flow and the `/team-task/verify`
API), `WORKFLOW_TEAM_TASK_VERIFY_COMMAND` defaults to `"true"`
on the Workflow hub daemon, so completed team tasks automatically promote to
`VERIFIED` once reported by the hub client. To enforce real project verification, set
`WORKFLOW_TEAM_TASK_VERIFY_COMMAND` to the project verification command (for
example, `npm test`). Setting it to an empty string (`""`) disables automatic
promotion and leaves completed tasks `VERIFYING` until verified via the
`/team-task/verify` API with the verifier capability. Ordinary hub-client
`/bash` requests cannot produce this evidence.

## Operational semantics (fail-closed)

| Condition | Behavior |
|---|---|
| workflow-hub not running | hub-resolving surfaces (Cline family) cannot authorize — startup fails; the browser/OpenCode and goose ACP surfaces carry in-process authority and are unaffected |
| authorization hook doesn't return `allow` | fails closed, task stays FAILED |
| guard unavailable/offline | fails closed, not advisory-from-here |
| obsolete hub discovery file | daemon in launcher's start transaction |

Sandbox/isolation remains the same as the TUI router today.

## Out of scope (deliberate)

- Self-service MCP manager persistence **(done — merged settings live at the
  stable `~/.workflow/cline_mcp_settings.json`; stale toolbox entries are
  pruned and self-service additions survive across runs)**
- Desktop app integration **(done — the `cline-hub` desktop app injects
  `createWorkflowHubHooks(workspace)` into every session's localRuntime, and
  its scheduled runs inherit the hub-daemon hooks; both fail closed)**

## Implementation sequence (suggested)

1. Extract hub daemon from existing `createWorkflowClineTuiBridge` + make it
   long-running; expose discovery token. **(done — `workflow-hub` bin)**
2. Launcher resolves against the global hub instead of spawning per-TUI helper.
   **(done — `src/cli/hub-client.ts`, fail-closed)**
3. Cron-runner in vendored clone uses the same authorize hooks (no CLI patch).
   **(done — hub daemon injects `createWorkflowHubHooks()` into every
   hub-started session)**
4. TUI/headless/zen connectors converge to the hub. **(done — every surface
   resolves the Workflow authority via env, falling back to the hub discovery
   file, so directly-launched and detached processes converge on the global
   hub without launcher plumbing)**

Acceptance for this milestone: a fresh session is *guarded by the hub* for
every surface, even scheduled mode, and the patch only remains responsible for
presentational overrides (art/view), not hook logic.

Drafting the implementation is next stop.
