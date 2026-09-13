# Workflow Hub Design (Option A)

## Goal

Workflow is the universal authority for every Cline surface. Interactive TUI,
headless CLI, zen, chat connectors, scheduled agents, teams, and desktop all
go through a single loopback hub that Workflow owns. `workflow` stops being a
launcher-side helper and becomes the actual system authority.

## Architecture

```
Cline (any surface, any version)
  │  hub endpoint: ws://127.0.0.1:<hubPort>  (Workflow-controlled)
  ▼
Workflow Hub (long-running daemon; npm bin `workflow-hub`)
  ├ Workflow authorization (today's loopback bridge, daemonized)
  ├ vendored toolbox MCP registrations (merged settings already exist)
  ├ containment / evidence authority over proposed actions
  ├ records task/evidence state in WorkflowApplication
  └ endpoint discovery file for Cline's `readHubDiscovery(...)`
```

The Workflow Hub is the *only* hub on the machine for this install. Cline's
`ensureCliHubServer` path is replaced: instead of spawning its own detached
hub, consumers connect to the Workflow hub for everything.

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

## Related surfaces (post-hub)

| Surface | Enforced via |
|---|---|
| Interactive TUI | direct hub client |
| Headless CLI (`workflow "..."`) | direct hub client |
| Zen | direct hub client |
| Connectors (Slack, Telegram, Discord, GChat, Linear, WhatsApp) | hub-side localRuntime hooks |
| **Scheduled agents** | hub-side cron with workflow-authorize hooks |
| Teams/desktop | hub-side localRuntime hooks |

## Commands

- `workflow-hub` — start the detached authority daemon (discovery + token).
- `workflow` — still the TUI launcher; resolves against the global Workflow hub.
- Launchers auto-spawn `workflow-hub` detached when the discovery file is
  missing or stale, guarded by `~/.workflow/hub/discovery.json.spawn.lock`.
  `WORKFLOW_AUTOHUB=0` restores strict fail-fast resolution.

For Cline team tasks, `WORKFLOW_TEAM_TASK_VERIFY_COMMAND` defaults to `"true"`
on the Workflow hub daemon, so completed team tasks automatically promote to
`VERIFIED` once reported by Cline. To enforce real project verification, set
`WORKFLOW_TEAM_TASK_VERIFY_COMMAND` to the project verification command (for
example, `npm test`). Setting it to an empty string (`""`) disables automatic
promotion and leaves completed tasks `VERIFYING` until verified via the
`/team-task/verify` API with the verifier capability. Ordinary Cline `/bash`
requests cannot produce this evidence.

## Operational semantics (fail-closed)

| Condition | Behavior |
|---|---|
| workflow-hub not running | Cline cannot authorize — startup fails |
| authorization hook doesn't return `allow` | fails closed, task stays FAILED |
| guard unavailable/offline | fails closed, not advisory-from-here |
| obsolete hub discovery file | daemon in launcher's start transaction |

Sandbox/isolation remains the same as the TUI router today.

## Out of scope (deliberate)

- Self-service MCP manager persistence **(done — merged settings live at the
  stable `~/.workflow/cline_mcp_settings.json`; stale toolbox entries are
  pruned and self-service additions survive across runs)**
- Pets UX (documented disabled)
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
