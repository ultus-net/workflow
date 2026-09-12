# Stage 3 Review

## Status

Stage 3 accepted on 2026-08-28.

Test Intelligence is a third independently publishable MCP product with deterministic Node test discovery, bounded execution, normalized failures, and structural file-to-test relevance. The Stage 3 gate is satisfied: an agent can move from a changed source file to ranked test candidates, execute explicit tests, and consume structured failures without parsing terminal output.

Symbol-to-test relevance remains deferred. Code Intelligence can identify definitions, references, and symbols, but no composition currently demonstrates that those semantic facts identify tests which exercise a symbol. Feeding a symbol's containing file into Test Intelligence would only restate P306's structural file heuristic, not add semantic evidence.

## Three-Product Evidence

All three products retain independent package identity, binaries, domain contracts, dependencies, documentation, tests, and packed-artifact verification. No product depends on another product, and the root remains orchestration-only.

The third product changes two Stage 2 observations:

- all three product `tsconfig.json` files use the same 14-line compiler contract, crossing Stage 2's explicit threshold to reconsider a shared base configuration;
- all three compiled-server MCP suites independently construct an SDK `Client`, launch `dist/server.js` with `StdioClientTransport`, connect, and close it, so the black-box stdio lifecycle now has three unchanged consumers.

The first is approved for a focused shared-base-config extraction. The second is approved as a narrowly scoped test-only extraction candidate. Neither requires or justifies a shared runtime package, and P307 records the decision rather than widening the review task into those refactors.

## Commonality That Stays Local

Do not extract a general `mcp-core` or cross-product contracts package. Server registration is only a few SDK calls, while each product's tools retain different request, error, security, cancellation, and side-effect semantics.

Code Intelligence and Test Intelligence have similar workspace-root, relative-file, limit, and structured-result boundary code. That duplication has only two consumers and is small enough that product-local schemas remain clearer. Reconsider it after another identical consumer or demonstrated maintenance drift.

Path confinement is not one shared contract. Code Intelligence must account for TypeScript projects and dependency/compiler-library files; Test Intelligence canonicalizes test IDs and assigns nearest-`package.json` project ownership; Workflow Guard reasons about protected, missing, symlinked, and out-of-workspace mutation paths. Generalizing those different trust rules would hide security semantics.

Cancellation and output bounds also stay local. Code Intelligence cooperatively checks cancellation around language-service work. Test Intelligence additionally owns subprocess timeout, process-group termination, normalized execution outcomes, and test/failure record limits. Workflow Guard's policy evaluation is synchronous. Package scripts and metadata remain product-local because their runtime dependencies, binaries, and post-build behavior differ.

## Extraction Decisions

The Stage 3 shared-infrastructure gate therefore yields a deliberately small change from Stage 2:

- approve a shared base TypeScript configuration because three products independently retained the identical compiler contract;
- approve extraction of only the repeated SDK black-box stdio client lifecycle when taken as a focused test-support task, keeping assertions, fixtures, package installation, and product behavior local;
- continue to reject shared MCP runtime/bootstrap, runtime schemas/contracts, generic path confinement, cancellation, timeout, and bounded-output abstractions;
- preserve dependency direction: independently publishable products may consume small shared infrastructure, but products must not depend on one another.

Symbol-to-test relevance should be reconsidered only when an explicit intelligence-layer composition can provide evidence beyond `exact_file`, `matching_stem`, and `same_project`, and dogfooding shows that evidence improves relevance precision.

Root `pnpm run verify` remains the repository quality gate. Workflow Guard's existing PR-preflight follow-ups remain separate product debt and do not block Stage 3 acceptance.

## Implemented Shared Infrastructure

The two approved extractions were implemented after the review. Root `tsconfig.base.json` now owns only location-independent compiler behavior; each product keeps `rootDir`, `outDir`, and `include` local so configuration inheritance does not change path resolution.

The private `@agent-tools/test-support` workspace package owns only the repeated compiled-server stdio client setup used by the three product MCP suites. It is test-only infrastructure: products import its source from repository tests, do not declare it as a runtime or publish dependency, and keep assertions, fixtures, packed-artifact installation, and product behavior local. The package has its own recursive typecheck and no build or publish surface.
