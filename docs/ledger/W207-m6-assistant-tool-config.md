# W207: M6 assistant tool config examples

Date: 2026-10-16. Branch: `feat/m6-assistant-tool-config`. Base: `6dea4684`.

## Goal

Define the canonical example MCP-tool config files that the operator deploys to fully configure the two learning-evidence tools in the M6 assistant lane.

## Decisions

**(a) Location of example config files.** Place them under `docs/assistant-config/` so the repo holds authoritative examples and the operator references them in deployment configs. This keeps vendor-specific tool capability docs (`mcp-toolbox/` docs) orthogonal to the canonical operator surface.

**(b) Tool-service binding.** Both `record_learning_evidence` and `learning_checkpoint` are served by the same MCP server (`learning-mcp`). The canonical map reflects this single-server binding.

**(c) Capability classification.** Both tools perform a mutation (write learner state), so they map to `{ capability: "mutation", mutating: true }`. The annotation in `mcp-toolbox/apps/learning-mcp/src/server.ts` already marks them as not `readOnlyHint: true`.

## Seam map

| Concern | Reusable seam | Note |
| --- | --- | --- |
| MCP-tool map parser | `parseAssistantMcpToolServerMap` (assistant-mcp-dispatcher.ts:92) | Returns a `Readonly<Record<string, string>>`; checked in examples. |
| Capability map parser | `parseMcpToolCapabilityMap` (mcp-tool-capability.ts:86) | Returns a `Readonly<Record<string, { capability: ToolCapability; mutating: boolean }>>`; checked in examples. |
| Example files location | `docs/assistant-config/` | New directory; holds JSON examples for read-only deployment reference. |
| CI registration | `test/ci-suites.txt` | Example suite comes after `/assistant-mcp-dispatch.test.ts`. |
| Authority doc update | `ASSISTANT_TOOL_AUTHORITY.md` | Short note that runtime env vars point to these files. |

## Slice

**New (examples):**

- `docs/assistant-config/mcp-tools.json` — tool name → MCP server name map.
- `docs/assistant-config/tool-capabilities.json` — tool name → `{ capability, mutating }` map.
- `test/assistant-tool-config-examples.test.ts` — example suite that reads the two files and asserts correct parsing.

## Acceptance

The example files parse successfully via the canonical parsers, and the test suite confirms that:
- `record_learning_evidence` and `learning_checkpoint` map to `"learning-mcp"`.
- Both entries have `{ capability: "mutation", mutating: true }`.

`npx tsc --noEmit` 0, `npm run lint` 0, `npm run build` clean, test registered in sorted `test/ci-suites.txt`.

## Roll forward

The operator deploys these files to the plane by overriding the environment variables referenced in the official authority docs:
- `WORKFLOW_ASSISTANT_MCP_TOOLS` → path to `docs/assistant-config/mcp-tools.json`.
- `WORKFLOW_ASSISTANT_TOOL_CAPABILITIES` → path to `docs/assistant-config/tool-capabilities.json`.

The plane values are supplied by deployment scripts; these JSON example files serve as the deployment manifest (checked in source).

## Generated files

- `docs/assistant-config/mcp-tools.json` ← tool name → MCP server name.
- `docs/assistant-config/tool-capabilities.json` ← tool name → `{ capability, mutating }`.
- `test/assistant-tool-config-examples.test.ts` ← validation suite.
- `docs/ledger/W207-m6-assistant-tool-config.md` ← this ledger.
