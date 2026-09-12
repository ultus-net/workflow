# TUI Integration Coverage

Interactive TUI, headless single-prompt mode, zen, and chat-platform
connectors (Slack, Telegram, Discord, Google Chat, Linear, WhatsApp) all
attach the Workflow authorization bridge:

- interactive: `createInteractiveSessionRuntime` wraps its runtime hooks
- headless: `runAgent` wraps its runtime hooks
- zen: `runZen` attaches `workflowBridgeLocalRuntime()` to the session request
- connectors: `buildConnectorStartRequest` (shared helper) attaches it for
  every adapter

**Gap: scheduled agents.** The hub-side cron runner builds session requests
inside `@cline/core`; client-side hook attachment cannot reach it. Scheduled
agents therefore run unguarded. Closing that requires a hub-side authority
seam (a Workflow-controlled hub), which is deliberately out of the current
patch scope.