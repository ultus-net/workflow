# Stage 0 Review

## Status

Stage 0 accepted on 2026-08-28.

The existing Workflow Guard package is a sufficient reference vertical slice for the monorepo. No generic MCP package should be extracted before Code Intelligence provides a second real consumer.

## Proven Product Boundary

The following behavior is now tested through the compiled/public boundary rather than only through source imports:

- a local stdio MCP process can initialize and advertise its tools;
- `guard_check` validates input at the MCP boundary;
- `guard_check` advertises and returns a structured decision contract;
- policy `allow` and `deny` outcomes remain successful tool evaluations;
- `guard_status` exposes the advisory/enforcement distinction;
- the npm artifact can be packed, installed into an isolated consumer, and launched through its installed binary;
- both declared package binaries are installed as executable shims.

## Patterns To Follow In Code Intelligence

These patterns are proven enough to use as starting conventions without extracting them yet:

- thin `McpServer` adapter over domain behavior;
- stdio as the local default transport;
- runtime validation at the MCP boundary;
- explicit structured output schema for stable machine-readable results;
- Node test runner plus `tsx` for TypeScript tests;
- black-box SDK client tests against the compiled server;
- packed-artifact smoke testing from an isolated consumer;
- product-specific package manifest, binary, dependencies, and release artifact.

## Potential Shared Infrastructure

The following may become shared after Code Intelligence demonstrates the same need:

- black-box MCP client/server test setup and teardown;
- MCP server identity/bootstrap conventions;
- package-artifact smoke-test helpers;
- cancellation/timeout propagation for asynchronous tools;
- output truncation and request-correlation conventions;
- schema/type authoring conventions used by more than one product.

These are observations, not approved extraction tasks.

## Workflow Guard-Owned Behavior

The following must not move into generic MCP infrastructure merely because another product shares the repository:

- policy evaluation and policy IDs;
- shell, Git, path, interpreter, and mutation-classification policy;
- protected branches and read-only role semantics;
- secret/tamper protections;
- PR preflight behavior;
- Claude hook enforcement mapping;
- the distinction between host-supplied workflow facts and deterministic guard decisions.

## Findings

The Stage 0 work exposed one useful contract improvement: `guard_check` previously returned `structuredContent` without advertising an `outputSchema`. It now advertises the stable decision fields and is covered by black-box tests.

The SDK's installed v1.29 client surface also differs in detail from newer source/documentation examples, reinforcing the decision to pin decisions to the package line in use and validate behavior with protocol-level tests during future SDK upgrades.

No evidence currently justifies `mcp-core`, a repository-wide `contracts` package, Nx, Turborepo, a different test runner, or a remote transport abstraction.

## Stage 1 Entry Criteria

Stage 1 can proceed with these decisions already made:

- pnpm workspaces are the monorepo standard;
- Node.js 22+ is the future workspace baseline;
- each MCP product is independently publishable to npm;
- shared packages are private by default;
- root verification orchestrates conventional package-level build/typecheck/test scripts;
- Workflow Guard behavior and npm artifact must remain stable during restructuring.
