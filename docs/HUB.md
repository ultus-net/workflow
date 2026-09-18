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
every surface, even scheduled mode. (The old Cline patch previously carried only
presentational overrides, not hook logic; it and the vendored runtime were
removed in W050 step 6, 2026-09-18.)

Drafting the implementation is next stop.
