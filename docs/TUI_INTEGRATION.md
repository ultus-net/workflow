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
