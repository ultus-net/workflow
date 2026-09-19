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

The Workflow Hub is the *only* hub on the machine for this install. Its HTTP
server is host-neutral (`src/integrations/hub-http.ts`); any hub client connects
to the Workflow hub for authorization and containment. Note the current default
surface — the browser operator UI over stock-ACP OpenCode — runs its own
in-process application authority and does not require the hub daemon; the hub's
dependent surfaces are every launcher that resolves it.

## Daemon protocol

- **Transport**: loopback WebSocket (host 127.0.0.1, port from config), auth
  token issued at hub start and written to the discovery file.
- **Discovery file**: `<data-dir>/hub/discovery.json` created atomically —
  `{ hubId, endpoint, authToken }` so `readHubDiscovery` finds it.
- **Routes**: `POST /health`, `/snapshot`, `/run/begin|review|finish`,
  `/review/rubric`, and `/bash` (contained shell). Specified as a versioned,
  SDK-neutral contract in `docs/HUB_PROTOCOL.md` (implementation:
  `src/integrations/hub-http.ts`; conformance: `test/hub-protocol.test.ts`).
  The Cline-specific `/before-tool` and `/team-task` routes were removed with
  the vendored SDK runtime in W050 step 6 (2026-09-18).
- **Authority migration**: today's per-TUI-loopback bridge is promoted into
  the hub daemon; interactive/headless/zen/connectors keep working, cron
  starts covering too.

## Route ↔ authority mapping

| Route invoked hub-side | Workflow hub does |
|---|---|
| `/run/*`, `/review/rubric` | Open/review/finish gated runs; hand out the 5-axis review rubric |
| `/bash` executor | WorkflowContainedProcess (bubblewrap isolation, workspace limits) |
| `/snapshot` | Project canonical task + run-gate state for monitoring surfaces |
| every ClientContribution | Registered and validated by the hub daemon, with audit history |

All authority uses `WorkflowApplication` task/evidence state. Actions that
can't be authorized fail **closed** (hub denies rather than guessing).

## Model routing (open-source pool)

The open-source pivot operates at the OpenRouter Auto Router level: the agent
default remains `openrouter/auto`, and the hub resolves the operator-configured
`~…-latest` alias pool (`WORKFLOW_OPENROUTER_AUTO_ALIASES` — open-source set:
`~deepseek/deepseek-flash-latest`, `~z-ai/glm-latest`, `~z-ai/glm-flash-latest`,
`~moonshotai/kimi-latest`) into the Auto Router's `allowed_models`; the routing
among the pool happens at OpenRouter, not in this stack. The per-vendor
direct-endpoint pools below are the opt-in cost path — they engage only when a
vendor key is configured (direct cost + context caching); families without
keys route through OpenRouter. Closed models remain available through an
explicit operator override (they are not deleted).

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
| ~~Teams/desktop~~ | **removed (W050, 2026-09-18)** — built on the retired vendored-Cline runtime |

The browser operator UI (OpenCode lead) and the ACP terminal surfaces
(`workflow-tui --driver acp|opencode`, goose) compose the application authority
in-process (`WorkflowApplication` + `createConfiguredAcpRuntime`, whole-agent
containment); they do not depend on the hub daemon. The hub remains the shared
authority for the retained `cline` connector and for launchers that resolve it.

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

For hub-run test evidence, `WORKFLOW_TEAM_TASK_VERIFY_COMMAND` is the run test
command: when set to a real command (for example, `npm test`), review-gated runs
also declare fresh passing `test:<workspace>` environment evidence and the verify
flow runs it. The default `"true"` — and an unset or empty value — declares no
test requirement, so those runs gate on the reviewer alone (plain runs gate on
the finish call). Ordinary hub-client `/bash` requests cannot produce this
evidence. The Cline-specific `/team-task` and `/team-task/verify` routes were
removed with the vendored SDK runtime in W050 step 6 (2026-09-18).

## Operational semantics (fail-closed)

| Condition | Behavior |
|---|---|
| workflow-hub not running | hub-resolving surfaces (the retained `cline` connector and other launchers) cannot authorize — startup fails; the browser/OpenCode and goose ACP surfaces carry in-process authority and are unaffected |
| authorization hook doesn't return `allow` | fails closed, task stays FAILED |
| guard unavailable/offline | fails closed, not advisory-from-here |
| obsolete hub discovery file | daemon in launcher's start transaction |

Sandbox/isolation remains the same as the TUI router today.

## Out of scope (deliberate)

- Self-service MCP manager persistence — **superseded (W050 C3/C4, 2026-09-18)**:
  the `~/.workflow/cline_mcp_settings.json` manager was retired with the
  vendored-Cline runtime; current MCP toolbox mounts are static config.
- Desktop app integration — **superseded (W050 step 6, 2026-09-18)**: the
  `cline-hub` desktop app was built on the vendored-Cline runtime, which was
  removed. The retained hub serves the browser operator UI and `workflow-tui`.

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
every surface, even scheduled mode. (The old Cline patch previously carried only
presentational overrides, not hook logic; it and the vendored runtime were
removed in W050 step 6, 2026-09-18.)

Drafting the implementation is next stop.
