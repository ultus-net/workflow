# MCP TypeScript SDK Baseline

## Status

Accepted for Stage 0 baseline validation on 2026-08-28.

This note records only SDK behavior that affects this repository. It is based on the official Model Context Protocol TypeScript SDK documentation and source for the v1.29.0 line, matching the repository's `@modelcontextprotocol/sdk` dependency range at the time of review.

## Existing Server Alignment

`src/server.ts` already follows the supported local-server pattern:

- `McpServer` is the intended high-level API for registering tools.
- `registerTool` accepts Zod raw-shape input schemas in the v1.x SDK.
- `StdioServerTransport` is the appropriate transport when an MCP client launches the server as a local child process.
- `await server.connect(new StdioServerTransport())` is the documented connection pattern.
- Returning both text `content` and `structuredContent` is supported.

No server rewrite is required to establish the monorepo baseline.

## Structured Output

The SDK supports an `outputSchema` on `registerTool`. When a tool declares one, successful calls are required to return `structuredContent`, and clients can validate that content against the advertised schema.

`guard_check` currently returns structured content but does not declare an output schema. That is valid, but it leaves the structured result as an undeclared contract. When protocol-level tests are added, define an output schema for the stable decision fields rather than relying only on the text JSON representation.

`guard_status` currently returns text content only. There is no need to introduce structured output until a consumer needs a machine-readable status contract.

## Errors

Tool/domain failures that are expected outcomes should be represented as tool results with `isError: true` and useful content. Protocol/input validation errors remain the SDK's responsibility.

Workflow Guard policy outcomes are not tool errors: `allow`, `deny`, and `ask` are successful policy evaluations and should continue to be returned as ordinary successful tool results.

Do not convert a policy denial into an MCP error.

## Cancellation

MCP request handlers receive request context containing an `AbortSignal`. Long-running work should observe that signal and stop promptly when the client cancels the request.

The current `checkPolicy` path is synchronous and deterministic, so adding cancellation checks to it would provide no practical value. New tools that spawn processes, query language servers, call remote systems, or perform other asynchronous work must propagate the request signal through their domain/provider boundary.

Cancellation behavior belongs in the black-box MCP test strategy once the repository has a cancellable tool; it should not be simulated by complicating Workflow Guard's synchronous policy engine.

## Lifecycle

The documented local-server baseline is a stdio transport connected to `McpServer`. Official SDK fixtures also demonstrate explicit SIGINT/SIGTERM cleanup around server handles for servers that own resources requiring cleanup.

Workflow Guard currently owns no persistent external resource beyond stdio. Stage 0 black-box tests should establish its observed launch/shutdown behavior before shared lifecycle infrastructure is designed. Future servers that own language-server processes, database pools, or network clients will need explicit cleanup and cancellation semantics.

## Schema Direction

The current code defines `GuardCheckInput` as a TypeScript interface in `src/policy.ts` and independently describes the MCP input with Zod in `src/server.ts`. Both are correct today, but they can drift.

When the Workflow Guard package boundary is revisited, prefer one authoritative runtime schema with inferred TypeScript boundary types where that does not couple the pure policy engine to MCP transport. Do not create a repository-wide contracts package solely to solve this one instance; Code Intelligence should provide the second consumer before shared contract machinery is extracted.

## Version Direction

This review intentionally targets SDK v1.29.0 because it matches the repository's current major-version line. The SDK also has newer/in-development API lines, so a future major-version upgrade should be handled as an explicit migration with official documentation and protocol tests rather than silently absorbed into monorepo restructuring.

## Consequences For Stage 0

- Keep the current high-level `McpServer` and stdio architecture.
- Add black-box protocol tests before extracting MCP bootstrap code.
- Add an explicit `guard_check` output schema as part of protocol-contract hardening, with tests.
- Preserve policy denials as successful domain results.
- Require abort propagation for future long-running/asynchronous tools.
- Defer generic lifecycle and contract abstractions until the second MCP product demonstrates common requirements.

## Official Sources

- MCP TypeScript SDK v1.29 server guide: <https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md>
- MCP TypeScript SDK v1.29 protocol guide: <https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/protocol.md>
- `McpServer` implementation and `registerTool` contract: <https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/mcp.ts>
