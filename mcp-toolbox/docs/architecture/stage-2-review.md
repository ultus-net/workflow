# Stage 2 Review

## Status

Stage 2 accepted on 2026-08-28.

Code Intelligence is a second independently publishable MCP product with end-to-end TypeScript definitions, symbols, references, and file diagnostics. The shared-infrastructure review does not justify a new shared runtime or contracts package before Stage 3.

## Observed Commonality

Both products independently use the MCP TypeScript SDK's high-level stdio lifecycle: construct an `McpServer`, register Zod-validated tools, connect a `StdioServerTransport`, and exercise the compiled server with an SDK `Client` plus `StdioClientTransport`. Both packages also use Node.js 22+, `tsc`, the Node test runner with `tsx`, product-local package metadata, and root `pnpm run verify` orchestration.

This is useful convention-level reuse, but the duplicated executable code is small. The black-box test setup shared by the two products is only client construction, launching `dist/server.js`, connection, and cleanup; each suite's assertions and fixtures remain product-specific.

The two 14-line product `tsconfig.json` files are currently identical. Keeping those files local duplicates configuration literally, but extracting inheritance or a config package would add another coupling point to remove only a small static file. Revisit this if a third TypeScript product retains the same compiler contract or the configurations become costly to keep aligned.

## Different Semantics

- Workflow Guard is an advisory policy product. Its public boundary includes allow/deny/ask decisions, host-dependent enforcement semantics, policy-specific input, and a separate Claude hook binary.
- Code Intelligence is a read-only semantic query product. Its tools use workspace/path validation, cancellation signals, normalized source locations, bounded results with evidence-based truncation, and TypeScript project lifecycle/confinement rules.
- Code Intelligence's domain contracts are intentionally language-neutral but are not consumed by Workflow Guard. Moving them into a shared contracts package would create a second package without a second contract consumer.
- The stdio transport/process lifecycle is identical. Request lifecycle is not: Code Intelligence propagates each MCP request's cancellation signal into potentially longer-running semantic work, while Workflow Guard's current synchronous policy handlers do not need that cancellation path.
- Error semantics differ as well. Workflow Guard represents expected policy outcomes, including denial and approval-required states, as successful structured MCP results. Code Intelligence throws for invalid source/project/confinement conditions after the MCP boundary has validated request shape, so those failures surface as MCP tool errors rather than domain result variants.
- Each product duplicates some product-local TypeScript shapes in its MCP Zod schemas: Workflow Guard's `GuardCheckInput`/`GuardDecision` correspond to `guard_check` runtime schemas, while Code Intelligence's source locations/diagnostics correspond to its domain adapter types and runtime output schemas. That duplication is deliberate at the runtime-validation boundary today. The shapes belong to different product domains, so it does not provide a cross-product contracts-package boundary; generating or centralizing schemas within either product would be a separate concern justified by drift, not by Stage 2 sharing.

## Extraction Decisions

Do not extract `mcp-core`, a contracts package, a test-helper package, or a shared `tsconfig` now. The current duplicated bootstrap/test setup is smaller and clearer when kept product-local. Transport/process lifecycle is shared, but request cancellation, domain error, security, and output-limit semantics are materially different.

Retain these as evidence to revisit after another concrete consumer appears:

- high-level stdio server/bootstrap convention;
- SDK black-box client lifecycle for compiled servers;
- product-local authoritative Zod input/output schemas;
- conventional package scripts consumed by root pnpm orchestration;
- cancellation, timeout, and bounded-output helpers only if another product independently needs identical semantics.

Any future extraction should remove demonstrated duplication without making product-specific security or lifecycle behavior generic. Dependencies must continue to flow from independently publishable products toward a small shared package, not between products.

## Stage 3 Entry Criteria

Test Intelligence should enter as another product/domain with its contract driven by the first real test-runner integration. Keep its runner discovery, execution, normalized failures, and safety semantics local initially. Revisit shared MCP/test infrastructure only after Test Intelligence supplies another concrete consumer whose code and semantics are actually identical.

Root `pnpm run verify` remains the repository quality gate. Workflow Guard's existing PR-preflight P2 follow-ups remain separate product debt and do not block the umbrella Stage 3 entry gate.
