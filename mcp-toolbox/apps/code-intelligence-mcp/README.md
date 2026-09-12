# Code Intelligence MCP

Structured, read-only semantic code navigation for coding agents, backed by the TypeScript Language Service.

Requires Node.js 22 or newer.

Run from a published package with `code-intelligence-mcp`. The stdio server exposes `find_definition`, `find_references`, `document_symbols`, `workspace_symbols`, and `diagnostics`. Position-based and file-scoped requests use an absolute `workspaceRoot` and workspace-relative `file`; source coordinates are 1-based. Reference, symbol, and diagnostic results are bounded with an explicit `truncated` flag, and workspace symbol search requires a non-empty query. Diagnostics combine TypeScript syntactic and semantic diagnostics for the requested file and normalize severity, code, message, and source location.
