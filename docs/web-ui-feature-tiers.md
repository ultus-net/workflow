# Web UI Feature Tiers — Gap Analysis & Implementation Plan

Date: 2026-09-15. Status: active roadmap. Branch: `fix/design-vs-code-audit`.

This document records the research-backed gap analysis between the Workflow
browser operator UI and mature AI-chat / coding-agent UIs, the tiered
implementation plan, and the scoping decisions made with the user.

Research sources: internal inventory of `src/ui/**`, `src/integrations/acp-*`,
`src/adapters/acp-*`; feature surveys of Open WebUI, LibreChat, LobeChat, Jan,
ChatGPT, Claude.ai, AnythingLLM (general chat UIs) and OpenCode, Zed Agent
Panel, Cursor, AionUi, acp-ui (coding-agent UIs); the ACP protocol surface
(agentclientprotocol.com, protocol v1 + v2 draft).

## Scoping decisions (user, 2026-09-15)

1. **Controls placement:** model/effort/mode pickers live composer-adjacent
   (ChatGPT/Claude/OpenCode pattern); remaining tool toggles in a settings
   popover.
2. **Permissions:** browser keeps server-side auto-resolve as the default;
   an opt-in "ask me" mode adds in-thread permission prompt cards.
3. **Capabilities:** `process`/`network` (shell, web tools) become toggleable
   in the browser only in Batch 3, after workspace confinement is enabled in
   the web CLI.
4. **Priority:** web UI plumbing + polish first; TUI improvements deferred.

## Headline finding

Model selection, effort, and tool toggles are **already on the wire**. The ACP
driver captures `availableModes`, `availableModels`, and `configOptions[]` from
`session/new` (`src/adapters/acp-subprocess.ts:102-126`), `setConfigOption` is
implemented and tested (`acp-session.ts:195-200`), and the TUI already cycles
these options (`src/ui/tui.tsx:543-563`). ACP's `configOptions` carries
`category: "mode" | "model" | "model_config" | "thought_level"` — the
protocol's sanctioned surfaces for mode, model, and reasoning-effort pickers.
The web path has no HTTP endpoint and no UI for any of it; the operator
projection drops the config summary (`src/ui/operator-session.ts:37-39`).

## Tier 0 — Implemented in the driver, missing only HTTP + render

| Feature | State today | Reference behavior |
|---|---|---|
| Model picker | `availableModels` + select configOption captured; TUI-only switching | Table stakes everywhere; mid-chat switch |
| Effort / thinking level | `category: "thought_level"` rides the same configOption path | ChatGPT effort slider, Claude Effort levels, Jan reasoning toggle, OpenCode variants |
| Mode selector (plan/act) | `availableModes` captured; `session/set_mode` NOT implemented client-side (SDK supports it) | OpenCode Build/Plan, Cursor Agent/Ask/Plan, acp-ui mode picker |
| Tool toggles | boolean configOptions capability already advertised (`acp-subprocess.ts:72`) | Zed per-tool permissions, AionUi YOLO, OpenCode allow/ask/deny |
| Plan rendering | ACP `plan` updates ignored (`acp-session.ts:245`) | Zed/Cursor plan checklists |
| Tool-call cards | only title + path captured; `kind`, `status`, `rawInput/Output`, `content[]` (incl. diffs) dropped | Typed tool cards w/ status + inline diffs in all coding UIs |
| Slash commands | `available_commands_update` ignored | OpenCode `/init` `/undo` `/compact`, acp-ui `/` menu |
| Usage / cost meter | metering proxy captures tokens+cost, serves nothing; `usage_update` ignored | OpenCode/Zed/Cursor per-session meters |
| Thinking blocks | `agent_thought_chunk` → `log` → filtered out | Collapsible reasoning (OWUI, acp-ui); OpenCode `/thinking` toggle |

### Batch 1 (config options — model/effort/mode/tool toggles)
- `GET /api/config-options` → current `configOptions[]` for the active session.
- `POST /api/config-options` `{id, value}` → guarded mutation (origin +
  JSON guards, same pattern as dismiss route); calls `setConfigOption`,
  returns full updated `configOptions[]`.
- Server: stop dropping config state in `operator-session.ts`; expose it on
  `GET /api/session` (or the new route) including `availableModes`.
- UI: composer-adjacent pickers for `category: "model"`, `"thought_level"`,
  `"mode"`; settings popover (gear button) for boolean tool toggles and
  `model_config` options. Optimistic update with server truth on next poll.
- Implement `session/set_mode` in `AcpSubprocessClient` if modes are not
  expressed as configOptions by the agent.

### Batch 2 (render what the projector drops)
- `plan` updates → plan checklist part in the thread.
- Tool calls → typed cards: kind icon, status, subject paths, collapsible
  raw input/output, inline diff rendering for `content[]` diff entries.
- `agent_thought_chunk` → collapsible "thinking" block (default collapsed).
- `usage_update` / proxy metrics → token + cost readout (composer footer or
  session header). Server: pass `onUsage` from `createConfiguredAcpRuntime`
  and serve the accumulated metrics.
- `session_info_update` → session title sync.

## Tier 1 — Protocol-supported, needs real server work

| Feature | Gap | Approach |
|---|---|---|
| In-thread permission prompts | Auto-resolved server-side (`acp-workflow-resolver.ts`); no ask flow | Opt-in "ask me" mode: pending-permission state in session channel, `POST /api/permission` guarded endpoint (allow_once/allow_always/reject_once/reject_always), prompt card UI with always-for-pattern affordance |
| Capability toggles (process/network) | Web CLI hardcodes `{read, mutation}` (`src/cli/web.ts:27-30`); TUI enables all four | Runtime capability reconfiguration endpoint; enable only after confinement |
| Workspace confinement | Not enabled in web CLI | Pass `workspaceRoot` in `cli/web.ts` before Batch 3 capability toggles |
| Session titles from agent | `session_info_update` → dropped | Feed into session registry title (Batch 2) |

## Tier 2 — Client-side value-adds (no protocol changes)

- Copy button (message + per-code-block) — universal table stakes.
- Syntax highlighting for code fences.
- Edit & resubmit / regenerate (client-side re-prompt).
- Keyboard shortcuts (cancel, new session, focus composer).
- Message queue while running (409 busy currently throws; queue instead).
- Export session to markdown.
- Completion notification (sound/desktop notification).
- Follow-the-agent affordance from `locations[].path` (already captured).
- Workflow-specific: retry failed task, add task, record evidence
  (application methods exist: `workflow.ts:135-188`).

## Tier 3 — General-chat table stakes needing design

- Search across sessions; session rename; share links (local-first design).
- Thumbs feedback on messages.
- Temporary/ephemeral chat (no registry persistence).
- System-prompt presets (response-style was TUI-side only; its TUI delivery was removed in W050 — no surface composes it now).

## Deliberately out of scope

Multi-user/RBAC/SSO, temperature sliders (agent-internal), voice/video, image
generation, i18n, MCP marketplaces, memory systems. This is a local
single-user operator tool; those belong to multi-tenant products.

## Invariants to preserve

- Browser is presentation-only: every mutation goes through a Workflow-owned
  endpoint with `isTrustedMutation` (origin/fetch-metadata 403) + JSON 415
  guards; ACP permission decisions stay routed through the Workflow resolver.
- One agent process at a time (multiplexed-driver latency fix is a separate
  follow-up).
- Tests mirror existing patterns: manager-level tests in
  `test/web-sessions.test.ts`, route guard tests in `test/web.test.ts`
  (403/415/404/200), UI verified via CDP smoke scripts.
