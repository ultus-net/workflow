# Stage 1 Review

## Status

Stage 1 accepted on 2026-08-28.

The workspace boundary is ready for a second product without another structural migration.

## Accepted Boundary

- `apps/workflow-guard-mcp` owns the independently publishable Workflow Guard package, dependencies, TypeScript configuration, tests, documentation, and binaries.
- the repository root is private orchestration only;
- pnpm owns the workspace lockfile and recursively runs each package's conventional build, typecheck, and test scripts;
- Node.js 22+ is the workspace baseline;
- repository CI performs a frozen install and invokes the same root verification command used locally;
- no shared MCP runtime, contracts package, test package, or TypeScript configuration has been extracted without a second concrete consumer.

## Stage 2 Entry Criteria

Code Intelligence should enter the workspace as its own independently publishable product with product-local dependencies, build configuration, tests, and runtime lifecycle initially.

Workflow Guard's package identity, binaries, policy behavior, and release artifact must remain independent. A second MCP product is not by itself evidence that an abstraction is shared; implement a concrete Code Intelligence vertical slice before extracting common infrastructure.

If both products then demonstrate an identical requirement, extract only the smallest proven common boundary with product-independent tests and dependencies flowing from products toward that shared package.

Long-running Code Intelligence operations must honor the cancellation and cleanup semantics identified in `mcp-sdk-baseline.md`. Root `pnpm run verify` must remain the repository quality gate and include substantive Code Intelligence package/runtime tests when that product is introduced.

Known Workflow Guard PR-preflight P2 follow-ups remain product debt and were not worsened by the workspace migration.
