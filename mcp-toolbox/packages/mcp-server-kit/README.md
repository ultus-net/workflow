# @agent-tools/mcp-server-kit

Shared MCP-server scaffolding: the logging-capable `McpServer` factory and the
leveled log + progress tool-registration wrapper that every toolbox app used to
copy into its own `src/server.ts`.

## Exports

- `createLoggingServer(serverInfo, options?)` — constructs an `McpServer` that
  advertises the MCP `logging` capability by default, merging any extra
  `ServerOptions` (extra capabilities, a `taskStore`).
- `installToolStreaming(server, { logger?, transform? })` — wraps
  `server.registerTool` so every tool call:
  - emits a `debug` "start" log and a `notifications/progress`
    `{ progress: 0, total: 2, message: "start" }` notification,
  - emits an `info` "done" log and `{ progress: 2, total: 2, message: "done" }`
    on success,
  - emits an `error` log and re-throws on failure.
  - Progress notifications fire **only** when the caller supplies
    `_meta.progressToken`. Logs fire **only** when `logger` is set
    (workflow-guard-mcp streams progress only).
  - The handler result passes through unchanged, or through `transform` (e.g.
    `boundToolResultText` from `@agent-tools/result-bounds`).
- `ToolExtra` — the request-handler `extra` shape the wrapper reads.

## Why no result-bounds dependency

The kit deliberately does **not** depend on `@agent-tools/result-bounds`. A
transitive workspace dependency does not survive `npm pack` bundling: a packed
app bundles the kit but a bundled workspace package's own `workspace:*`
dependency is left dangling (`../` tar members, `ERR_MODULE_NOT_FOUND` at
runtime). Servers that bound their results (code/test/project-memory/skills/
browser-verification/workflow-task) pass `boundToolResultText` in as the
`transform`.

## Verification

    pnpm --filter @agent-tools/mcp-server-kit run verify
