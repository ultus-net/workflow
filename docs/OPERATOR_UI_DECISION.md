# Operator UI decision: adopt assistant-ui as the presentation layer

**Status:** Accepted - 2026-09-15
**Decision owner:** operator
**Context:** `docs/OPERATOR_UI.md`, `docs/UI_INTEGRATION.md`, `docs/HUB_PROTOCOL.md`

## Context

Workflow's current Ink surface implements generic chat mechanics itself: prompt
editing, transcript scrolling, menus, activity rendering, and session event
formatting. That work has become a product cost without improving Workflow's
core authority model. The replacement must reuse maintained UI primitives while
keeping authorization, containment, task/evidence state, verification, and
session identity inside Workflow.

Current upstream documentation was evaluated for AI SDK 7 and assistant-ui:

- AI SDK `ChatTransport` supports custom transports and remote agents, and
  `@ai-sdk/tui` supplies a complete terminal chat with streaming Markdown, tool
  cards, reasoning sections, scrolling, and approval prompts.
- AI SDK tool approvals are part of its agent/tool execution lifecycle. Using
  that lifecycle as Workflow's approval authority would duplicate the hub's
  `/bash` authorization and containment boundaries.
- assistant-ui supports React web and React Ink surfaces with shared primitives.
  Its custom-runtime documentation explicitly supports externally owned message
  state and custom backends. `ExternalStoreRuntime` is intended for applications
  that already own their state, while `AssistantTransport` can project richer
  agent state and bidirectional commands.

Sources consulted 2026-09-15:

- https://www.assistant-ui.com/docs
- https://www.assistant-ui.com/docs/runtimes/custom/overview
- https://www.assistant-ui.com/docs/ink
- https://ai-sdk.dev/docs/ai-sdk-ui/transport
- https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage
- https://ai-sdk.dev/docs/agents/terminal-ui

## Decision

Adopt **assistant-ui as Workflow's preferred presentation component/runtime
layer**, starting with the browser surface. Build one Workflow-owned operator
session projection that maps canonical session and application events into the
presentation model; browser and terminal renderers consume that projection.

The integration boundary is deliberately one-way with respect to authority:

`Workflow hub/session -> operator projection -> assistant-ui runtime/primitives`

UI callbacks may submit user intent back to Workflow, but assistant-ui does not
decide whether a tool is authorized, whether containment is active, whether
evidence is fresh, or whether a task is verified. Those decisions remain in the
existing application/hub paths.

Use AI SDK UI message/transport interoperability where it removes integration
work, but do not adopt `ToolLoopAgent`, `DirectChatTransport`, or AI SDK tool
approval as Workflow's authority. `@ai-sdk/tui` remains an option for a thin
terminal client if its fixed interaction model is sufficient; it is not the
foundation for Workflow semantics.

## Consequences

- Stop expanding the custom Ink chat framework in `src/ui/tui.tsx`. Keep it as
  a fallback/migration surface until the replacement reaches operator parity.
- The first implementation seam is a framework-neutral operator projection,
  not a new renderer. It should encode the default `intent + actions` hierarchy
  from `docs/OPERATOR_UI.md` and keep diagnostic telemetry out of the primary
  transcript.
- The browser is the first full assistant-ui consumer because it can use the
  mature React component ecosystem without recreating browser interactions in
  Ink. A later terminal client should reuse the same projection through
  `@assistant-ui/react-ink` or use `@ai-sdk/tui` when its transport contract is
  sufficient.
- Adding assistant-ui packages is deferred until a surface actually consumes
  them. The projection contract can be tested without introducing UI-framework
  dependencies into Workflow's kernel/application packages.

## Alternatives considered

- **Continue the custom Ink UI** - rejected. It spends maintenance effort on
  generic interaction primitives and has already produced menu/transcript UX
  problems unrelated to Workflow's differentiating authority features.
- **Use `@ai-sdk/tui` as the universal UI foundation** - rejected as the primary
  foundation. It is attractive for a thin terminal, but its direct-agent and
  approval paths are more opinionated than Workflow's authority boundary and it
  does not provide the desired browser component system.
- **Use AI SDK UI directly for every surface** - viable as a transport/message
  protocol, but less suitable as the presentation-component choice. Keep this
  as an interoperability seam rather than coupling Workflow semantics to an AI
  SDK agent runtime.
