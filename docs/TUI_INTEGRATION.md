# TUI Integration Coverage

Interactive TUI, headless single-prompt mode, zen, and chat-platform
connectors (Slack, Telegram, Discord, Google Chat, Linear, WhatsApp) all
attach the Workflow authorization bridge:

- interactive: `createInteractiveSessionRuntime` wraps its runtime hooks
- headless: `runAgent` wraps its runtime hooks
- zen: `runZen` attaches `workflowBridgeLocalRuntime()` to the session request
- connectors: `buildConnectorStartRequest` (shared helper) attaches it for
  every adapter

- scheduled agents: `createWorkflowHubHooks` in the hub daemon attaches
  authorization hooks to every hub-started session and opens dedicated tasks
  via `/run/begin` and `/run/finish`

## Staged universal TUI convergence

`workflow-tui` composes an explicit `cline`, `opencode`, or `acp` host session
driver onto the SDK-neutral `WorkflowTui`. It currently owns standalone local
authority rather than driving the hub's canonical session. The patched Cline
CLI TUI stays the primary interactive surface until every item in
`docs/TUI_PARITY.md` passes; afterwards the primary surface can flip to
`workflow-tui` and per-SDK patched TUIs can become optional surfaces.

> **Superseded 2026-09-16** (the same day this doc was written, by the
> `docs/ACP_DECISION.md` Pivot): the lead interactive path is the
> hub-composed stock-ACP OpenCode surface (`WORKFLOW_ACP_AGENT=opencode`,
> contained `opencode acp --pure`); the patched Cline CLI TUI is retained
> fallback insurance, and the workflow-tui flip criterion above is no longer
> the operative plan. The standalone-local-authority statement remains true.

## Terminal theme (decision 2026-09-16, operator-approved)

The universal `WorkflowTui` previously inherited the terminal foreground with
no assigned accents (pinned by test). The polish pass lifted that policy to a
**terminal-derived theme**: accents pull the user's own terminal palette, they
never override it.

- Only chalk's basic-16 **named ANSI slots** are used (`cyan`, `green`,
  `yellow`, `red`, `gray`). Ink routes named colors straight through chalk,
  which emits the themeable codes (`\e[36m` …) the terminal remaps — so a
  Nord/Catppuccin/Solarized terminal shows *its* cyan, not a Workflow-chosen
  RGB.
- Hex, `rgb()`, and `ansi256()` values are forbidden for accents — they would
  pin fixed colors over the theme.
- `NO_COLOR` degrades to plain text automatically (chalk drops to level 0);
  `FORCE_COLOR`/terminal detection behave like any chalk app.
- The allowlist and the accent constants are pinned by `test/tui.test.ts`
  ("Ink projection pulls the terminal theme…") so future accents stay
  deliberate, and `docs/TUI_PARITY.md` records the divergence from the
  inherit-only policy.

### Terminal-derived composer tint (OSC 11)

The one permitted background is itself sampled **from the user's terminal**:
before Ink takes over stdin, the CLI entries (`acp-tui`, `universal-tui`,
`ink-tui` standalone) query the terminal's real background color with an
OSC 11 query (`src/ui/terminal-theme.ts`, 200 ms fail-soft window — the same
technique Codex CLI and the OpenRouter `create-agent-tui` skill use) and
blend a subtle wash derived from it: dark backgrounds get white at 12% alpha,
light backgrounds get black at 4%. With a tint the composer renders as the
borderless "block" input style over the user's own background; without one
(piped stdin, tmux without passthrough, CI) it falls back to the bordered
composer that works on any terminal. The pinned theme test enforces that the
only background assignment in the TUI source is this detected value — never a
hardcoded color.

The stdin handoff contract is load-bearing and pinned by the PTY e2e
(`test/tui-e2e.test.ts`): detection must leave the TTY **read-started and
flowing** (`resume()`), because Ink consumes stdin through a `readable` pump
and never calls `resume()` itself — a paused stdin starves the interface of
keystrokes. Late OSC responses are dropped by an input filter in `useInput`
so they cannot leak into the composer. Keystrokes typed during the ≤200 ms
query window are discarded (the interface is not yet rendered); the window is
bounded and fail-soft.

The rest of the polish (header frame, spinner, glyphs, timestamps) is
formatting on the default foreground and carries no color policy.
