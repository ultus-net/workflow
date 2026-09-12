# Code Intelligence Contract

## First Vertical Slice

The first capability is `find_definition` for TypeScript projects.

The MCP input is exact rather than fuzzy:

- `workspaceRoot`: absolute project/workspace directory;
- `file`: workspace-relative source file path;
- `line`: 1-based source line;
- `column`: 1-based source column.

The output contains zero or more normalized locations. Each location has a workspace-relative `file`, 1-based `line` and `column`, plus 1-based `endLine` and `endColumn`. Empty definitions are a successful empty result, not an MCP failure.

Invalid paths, files outside the workspace, missing source files, and project-loading failures are errors. Inputs are validated at the MCP boundary, while the domain adapter independently enforces workspace confinement because it can be reused outside MCP.

## Domain Boundary

The domain depends on a small language-neutral interface:

```ts
interface LanguageServiceAdapter {
  findDefinition(query: SourcePosition, signal?: AbortSignal): Promise<readonly SourceLocation[]>;
}
```

`SourcePosition` and `SourceLocation` contain no TypeScript compiler or LSP types. The first adapter uses TypeScript's in-process `LanguageService`; future languages may use LSP without changing the public domain contract.

Fuzzy symbol discovery does not belong in `find_definition`. It will be introduced, if useful, as a separate symbols/search capability so exact semantic navigation never guesses which declaration the caller meant.

## TypeScript Project Semantics

The first adapter finds the nearest `tsconfig.json` at or above the requested file without leaving `workspaceRoot`, parses it using TypeScript's configuration APIs, and creates an in-process Language Service over the configured files. This preserves TypeScript module resolution and compiler options instead of approximating semantics with AST text matching.

Results outside `workspaceRoot`, including dependency/library definitions, are omitted from the normalized workspace result. This first product answers questions about the requested repository; it does not expose arbitrary host files through semantic navigation.

The adapter checks cancellation before project loading and before/after semantic work. TypeScript's synchronous Language Service cannot be interrupted in the middle of a single call, so cancellation is cooperative at operation boundaries rather than preemptive.

## Fixtures

The deterministic fixture is a small real TypeScript project with a `tsconfig.json` and at least two source files. It proves:

- cross-file definition lookup;
- 1-based MCP coordinates and normalized workspace-relative outputs;
- an unresolved symbol returns an empty result;
- path traversal/out-of-workspace input is rejected;
- missing files are rejected;
- already-aborted work does not perform a semantic query.

Black-box MCP tests launch the compiled stdio server and repeat the cross-file lookup through the public tool. Package smoke tests pack the Code Intelligence npm artifact, install it into an isolated consumer, and launch its installed binary just as Workflow Guard does.

## Deliberately Deferred

After this slice is proven, add `document_symbols`, `workspace_symbols`, `find_references`, and `diagnostics` incrementally. Do not add tree-sitter, embeddings, a persistent index, an external LSP process manager, or mutation/refactoring tools as part of this slice.

## Symbol Discovery

Symbol discovery uses a flat normalized model shared by document and workspace queries: `name`, normalized `kind`, and a workspace-relative source location. Document hierarchy is deliberately not part of the shared contract because workspace search is inherently flat.

Both symbol tools are bounded. Inputs accept an optional positive `limit` with a default of 100 and maximum of 500. Outputs return `symbols` plus explicit `truncated`; `truncated` is true only when the service observed at least one additional matching symbol beyond the returned limit, so callers never have to infer truncation from `symbols.length`.

`document_symbols` accepts the same absolute `workspaceRoot` and workspace-relative `file` path shape as definition lookup. It returns declarations in deterministic source order and flattens nested declarations.

`workspace_symbols` additionally requires a non-empty `query`. It is search, unlike `find_definition`: prefix, substring, and camel-case matches are allowed according to the language adapter. Results are normalized and deterministically ordered before applying the public bound. Empty-query whole-workspace enumeration is deliberately excluded from this first search contract.

## Reference Navigation

`find_references` uses the same exact source-position semantics as `find_definition`: absolute `workspaceRoot`, workspace-relative `file`, and 1-based `line`/`column`. It returns semantic occurrences reported by the language adapter, including a declaration occurrence when the underlying language service reports one; declaration classification is deliberately not part of the language-neutral contract.

References use normalized workspace-relative `SourceLocation` values and exclude dependency and out-of-workspace results. Results are sorted deterministically by file, start position, then end position before applying the public bound. The optional positive `limit` defaults to 100 and has a maximum of 500. Output contains `locations` and explicit `truncated`, which is true only when at least one additional permitted reference was observed after confinement filtering. Unresolved symbols return an empty, non-truncated result and already-aborted requests do not perform semantic reference work.

## Diagnostics

`diagnostics` is file-scoped in this first slice. It accepts an absolute `workspaceRoot`, a workspace-relative `file`, and the same optional positive `limit` used by symbols and references (default 100, maximum 500). File scope keeps the operation bounded and avoids implying whole-project/configuration diagnostics that TypeScript's Language Service does not expose through one equivalent file-local call.

Each normalized diagnostic contains `severity` (`error`, `warning`, `information`, or `hint`), numeric language diagnostic `code`, flattened `message`, and a workspace-relative `SourceLocation`. The TypeScript adapter combines syntactic and semantic diagnostics for the requested source file. Diagnostics without a source-file location are outside this file-scoped contract and are omitted.

Results exclude dependency and out-of-workspace locations, are deduplicated, and are sorted deterministically by file, start position, end position, severity, code, then message before applying the public bound. Output contains `diagnostics` and explicit `truncated`; `truncated` is true only when at least one additional permitted diagnostic was observed after filtering and deduplication. A clean file returns an empty, non-truncated result. Cancellation is cooperative around TypeScript's synchronous diagnostic calls, matching the existing semantic operations.
