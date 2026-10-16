/**
 * MCP tool classification: the "declared per-tool capability map" (W205
 * decision (b)).
 *
 * The assistant tool loop (`assistant-tool-loop.ts`) hands every tool call it
 * parses to an executor. The executor must name the capability a call requires
 * before `WorkflowApplication.authorize()` can gate it (`workflow.ts:243-252`),
 * but an arbitrary MCP tool has no capability in the host-tool sense
 * (`opencodePermissionCapability` maps host names only). This module supplies
 * that classification.
 *
 * Three layers, in precedence order:
 *
 * 1. What the MCP server already ships: every tool declares `annotations` with
 *    `readOnlyHint` (`mcp-toolbox/apps/learning-mcp/src/server.ts:114,149,169,
 *    185,201`). `classFromAnnotations` seeds a class from it.
 * 2. What the operator composes: an override map wins per tool name
 *    (`mergeCapabilityMap`), because an operator declaration outlives a server
 *    default.
 * 3. Nothing: a tool absent from both fails CLOSED to the strictest class
 *    (`process` + `mutating`, `STRICTEST_MCP_TOOL_CLASS`), so an undeclared
 *    tool can never slip past a withheld set. This is the property that makes
 *    the care route's withheld set enforcement rather than a label.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import type { ToolCapability } from "../application/host.js";

/** The six capability strings, as a runtime value, for validation. */
const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  "read",
  "mutation",
  "process",
  "spawn",
  "credentials",
  "network",
];

/** The declared capability class for a single MCP tool. */
export interface McpToolClass {
  readonly capability: ToolCapability;
  readonly mutating: boolean;
}

/** A per-tool capability map, keyed by tool name. */
export type McpToolCapabilityMap = Readonly<Record<string, McpToolClass>>;

/**
 * The strictest class: what an undeclared tool resolves to. `process` is the
 * highest-effect non-mutating class and `mutating` forces every mutating-only
 * policy (workspace confinement, read-before-write) to apply. Mirrors the
 * dispatcher defaults at `src/adapters/opencode.ts:40` and `acp.ts:49`.
 */
export const STRICTEST_MCP_TOOL_CLASS: McpToolClass = { capability: "process", mutating: true };

/**
 * Classify an MCP tool by lookup. Returns the declared class for `name`, else
 * `STRICTEST_MCP_TOOL_CLASS`. Never returns `undefined`: the loop must always
 * have a capability to hand `authorize()`. A blank name (after trimming) also
 * yields the strictest class.
 */
export function classifyMcpTool(name: string, map: McpToolCapabilityMap): McpToolClass {
  const trimmed = name.trim();
  if (trimmed.length === 0) return STRICTEST_MCP_TOOL_CLASS;
  return map[trimmed] ?? STRICTEST_MCP_TOOL_CLASS;
}

/**
 * Seed a class from an MCP server's own `annotations` block. `readOnlyHint:
 * true` means the tool declares no write effect, so it is `read` and
 * non-mutating. Every other case (false, absent) is `mutation` + mutating: the
 * fail-closed reading of an unstated or negative hint.
 */
export function classFromAnnotations(input: { readonly readOnlyHint?: boolean }): McpToolClass {
  if (input.readOnlyHint === true) return { capability: "read", mutating: false };
  return { capability: "mutation", mutating: true };
}

/**
 * Validate an operator config value into an `McpToolCapabilityMap`. Fails
 * closed: a non-object, a non-object entry, an unknown capability string, or a
 * non-boolean `mutating` each throw a `TypeError`.
 */
export function parseMcpToolCapabilityMap(value: unknown): McpToolCapabilityMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("MCP tool capability map must be an object");
  }
  const result: Record<string, McpToolClass> = {};
  for (const [toolName, toolEntry] of Object.entries(value)) {
    if (typeof toolEntry !== "object" || toolEntry === null || Array.isArray(toolEntry)) {
      throw new TypeError("MCP tool capability for '" + toolName + "' must be an object");
    }
    const entry = toolEntry as Record<string, unknown>;
    const capability = entry.capability;
    if (typeof capability !== "string" || !(TOOL_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new TypeError("MCP tool '" + toolName + "' has an unknown capability string");
    }
    const mutating = entry.mutating;
    if (typeof mutating !== "boolean") {
      throw new TypeError("MCP tool '" + toolName + "' must declare a boolean mutating flag");
    }
    result[toolName] = { capability: capability as ToolCapability, mutating };
  }
  return result;
}

/**
 * Merge server annotation seeds with an operator override. The operator map wins
 * per tool name; the annotation seed governs every tool the operator left
 * undeclared. Neither input is mutated.
 */
export function mergeCapabilityMap(
  annotations: Readonly<Record<string, { readonly readOnlyHint?: boolean }>>,
  override: McpToolCapabilityMap,
): McpToolCapabilityMap {
  const merged: Record<string, McpToolClass> = {};
  for (const [toolName, annotation] of Object.entries(annotations)) {
    merged[toolName] = classFromAnnotations(annotation);
  }
  for (const [toolName, overrideClass] of Object.entries(override)) {
    merged[toolName] = overrideClass;
  }
  return merged;
}
