# Code Intelligence Upstream Survey

Survey date: 2026-08-28.

## Decision

Do not fork or reproduce a generic multi-language code-intelligence MCP as the next product.

For the first Code Intelligence vertical slice, use the TypeScript Language Service directly for TypeScript semantics and the official MCP TypeScript SDK for the protocol boundary. Treat LSP as the future language-independent adapter boundary when a second language justifies it. Borrow agent-oriented tool design from mature code MCPs, but do not add tree-sitter, embeddings, a persistent repository index, or an LSP process manager before a concrete requirement demands them.

## Authoritative Building Blocks

### Model Context Protocol TypeScript SDK

Source: https://github.com/modelcontextprotocol/typescript-sdk

The repository already uses the official SDK. Version 1.29 documentation confirms `McpServer`, `registerTool`, stdio transport, structured output schemas, and request cancellation via the handler signal. We should depend on the SDK rather than copy protocol or transport code.

### TypeScript

Source: https://github.com/microsoft/TypeScript

License: Apache-2.0.

TypeScript's `LanguageService` already provides the semantic operations needed by the planned first product: definitions, references, diagnostics, quick information, rename locations, call hierarchy, outlining, and other editor features. The first TypeScript implementation should wrap this API rather than recreate semantic analysis with AST traversal.

### VS Code Language Server Node

Source: https://github.com/microsoft/vscode-languageserver-node

License: MIT.

This is the primary Node ecosystem for LSP protocol types, JSON-RPC, clients, and servers. It is the preferred future building block if Code Intelligence begins managing external language servers. It should not be introduced merely to put an LSP-shaped layer in front of TypeScript's in-process Language Service.

## MCP Implementations Surveyed

Popularity figures are GitHub star counts observed on the survey date and are only rough adoption signals.

### Serena

Source: https://github.com/oraios/serena

Observed popularity: about 28.5k stars. License: MIT. Implementation: Python plus language-server integrations across many languages.

Serena is the strongest general semantic-code MCP reference found. It exposes agent-level operations for symbols, references, declarations/implementations, diagnostics, rename, and symbol editing rather than simply mirroring raw LSP requests.

Recommendation: study and interoperate; do not fork. Its maturity substantially raises the bar for any generic multi-language Code Intelligence product we would ship. Borrow the principle of task-oriented semantic tools and bounded results.

### jCodeMunch MCP

Source: https://github.com/jgravelle/jcodemunch-mcp

Observed popularity: about 2.6k stars. License: custom/NOASSERTION in GitHub metadata, with commercial-use terms documented by the project. Implementation: tree-sitter plus persistent symbol indexing.

Interesting concepts include symbol bodies/outlines, importers, call hierarchy, blast-radius and changed-symbol queries, task-context assembly, and explicit coverage/freshness concepts.

Recommendation: concepts only unless licensing is reviewed for a specific use. Do not copy implementation code or add it as a product dependency by default.

### code-index-mcp (johnhuang316)

Source: https://github.com/johnhuang316/code-index-mcp

Observed popularity: about 1k stars. License: MIT. Implementation: Python, shallow file indexing, optional tree-sitter deep indexing, native text search, caching, and filesystem watching.

Its shallow/deep split is a useful model for progressive cost: basic discovery does not require constructing the expensive semantic index.

Recommendation: borrow the progressive-indexing principle if persistent indexing becomes necessary. Do not add the machinery to the first TypeScript Language Service slice.

### Open Codebase Index

Source: https://github.com/Helweg/open-codebase-index

Observed popularity: about 180 stars. License: MIT. Implementation: TypeScript orchestration with a Rust N-API core using tree-sitter, SQLite, vector search, and BM25. The project explicitly supports OpenCode and was active on the survey date.

The distinction between bounded context/peek operations, exact implementation lookup, broader search, and graph operations is valuable API design for agents.

Recommendation: study and consider as a complementary MCP for fuzzy repository discovery. Do not reproduce its index stack unless measured product requirements exceed TypeScript/LSP semantics and ordinary repository search.

### code-index-mcp (Regsorm)

Source: https://github.com/Regsorm/code-index-mcp

Observed popularity: about 100 stars. License: MIT. Implementation: Rust, tree-sitter, SQLite, official Rust MCP SDK.

It persists symbols, source bodies, and calls and exposes symbol/function/file-summary/caller/callee/path queries.

Recommendation: architecture reference for a future standalone local index. No current dependency need.

### mcp-server-tree-sitter

Source: https://github.com/wrale/mcp-server-tree-sitter

Observed popularity: about 300 stars. License: MIT. Implementation: tree-sitter-backed AST, symbols, queries, usages, dependencies, and complexity.

The repository is archived as of the survey date.

Recommendation: historical design reference only; do not adopt as a new dependency.

### lsp-mcp-server

Source: https://github.com/ProfessioneIT/lsp-mcp-server

Observed popularity: small (about 20 stars). License: MIT. Implementation: TypeScript LSP-to-MCP bridge with multiple roots, diagnostics caching, process lifecycle/restart handling, workspace-boundary checks, and dry-run rename.

Recommendation: useful reference for the lifecycle complexity we should expect before adding external language-server adapters. Prefer the upstream VS Code LSP packages for protocol implementation rather than copying this bridge.

### Official MCP Servers

Source: https://github.com/modelcontextprotocol/servers

Observed popularity: about 90k stars. Licensing varies by area/history; inspect the exact source before copying. The repository describes these as reference implementations rather than production solutions and does not currently provide a canonical code-intelligence server.

Recommendation: follow its MCP conventions where applicable, but it does not remove the need to choose a semantic engine.

## What To Reuse

Depend directly on authoritative protocol/semantic libraries: the MCP TypeScript SDK, TypeScript Language Service, and later the VS Code LSP packages if external language servers become a real requirement.

Adapt these design ideas without copying implementation:

- semantic, task-level operations rather than raw protocol methods;
- bounded responses suitable for an agent context window;
- exact symbol lookup distinct from fuzzy repository search;
- explicit freshness/coverage when results depend on an index;
- cheap discovery paths before expensive indexing;
- inspect/dry-run behavior separated from mutations;
- cancellation and deterministic cleanup for long-running operations.

## What Not To Build Yet

- a generic multi-language LSP process manager;
- a tree-sitter grammar/index stack;
- embeddings or vector search;
- a persistent symbol database;
- a generic search replacement for `rg`/host filesystem tools;
- symbol editing/refactoring before read-only semantic intelligence is proven;
- a public shared MCP-core package.

These are mature solution spaces already. Any future implementation should be justified by a concrete capability or reliability gap rather than by the desire to own the stack.

## Stage 2 Implication

The first vertical slice should prove that an agent benefits from a small, stable MCP contract over TypeScript's own Language Service. A good candidate is exact definition/reference navigation plus normalized locations against a fixture TypeScript project, followed by diagnostics and symbols incrementally.

Before extracting shared MCP infrastructure, compare that concrete product with Workflow Guard as already required by the Stage 2 review gate.
