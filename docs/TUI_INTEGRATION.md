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