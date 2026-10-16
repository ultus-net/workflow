# W205 S1: the MCP tool capability map

Date: 2026-10-16. Branch: `feat/w205-mcp-capability-map`. Base: `16ff0b95`.

## Goal

Slice S1 of `docs/ASSISTANT_TOOL_AUTHORITY.md`. Supplies the classifier the
assistant tool executor (S2) needs to name a capability before
`WorkflowApplication.authorize()` can gate an MCP tool call. This is decision
(b) from the W205 spec: a declared per-tool capability map, with an undeclared
tool failing closed to the strictest class.

## What landed

**New:** `src/integrations/mcp-tool-capability.ts`.

| Export | Role |
| --- | --- |
| `McpToolClass` | `{ capability: ToolCapability; mutating: boolean }` |
| `McpToolCapabilityMap` | `Readonly<Record<string, McpToolClass>>` |
| `STRICTEST_MCP_TOOL_CLASS` | `process` + `mutating`, the fail-closed default |
| `classifyMcpTool(name, map)` | declared class, else strictest; never `undefined`; blank name → strictest |
| `classFromAnnotations({ readOnlyHint })` | seed from what MCP servers ship: `true` → `read`/non-mutating, else `mutation`/mutating |
| `parseMcpToolCapabilityMap(value)` | validate operator config; throws on non-object, unknown capability, non-boolean `mutating` |
| `mergeCapabilityMap(annotations, override)` | annotation seeds, operator override wins per tool name; neither input mutated |

Three layers of precedence, documented in the module header: server annotation
seed, operator override, strictest fail-closed default.

## Design note

The servers already declare `annotations.readOnlyHint` per tool
(`mcp-toolbox/apps/learning-mcp/src/server.ts:114,149,169,185,201`), so the map
does not invent a new declaration format: `classFromAnnotations` bridges the
existing annotation into the executor's class shape, and the operator config
overrides it. `mutating` rides alongside `capability` because the canonical
ordering derives it from capability in the host adapters
(`src/adapters/opencode.ts:40`) and the executor needs the same pair for
`ProposedToolAction`.

## Acceptance

- `test/mcp-tool-capability.test.ts`: 15/15. Declared hit; absent and blank name
  → strictest; `readOnlyHint: true` → `read`/non-mutating; `false`/absent →
  `mutation`/mutating; operator override beats annotation; an undeclared tool
  keeps its annotation seed; `mergeCapabilityMap` does not mutate its inputs;
  `parse` throws on non-object, unknown capability, non-boolean `mutating`; a
  well-formed six-entry map round-trips.
- `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npm run build` clean.
- `test/ci-suites-manifest.test.ts`: 5/5 (the suite is registered in sorted order
  after `test/kernel-purity.test.ts`).
- Related: `assistant-tool-loop` + `assistant-isolation` + `assistant-gateway`
  15/15.

## Not in this slice

The executor (S2) that calls `classifyMcpTool` and feeds `authorize()`. The
module has no caller yet; it is a pure, tested unit.
