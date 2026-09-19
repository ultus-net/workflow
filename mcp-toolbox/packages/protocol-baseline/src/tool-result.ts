import type { Catalog, CatalogTool } from "./catalog.js";

/**
 * The toolbox tool-result contract for the MCP 2026-07-28 baseline.
 *
 * SDK convention (server/mcp.ts): a tool that declares `outputSchema` must
 * return `structuredContent`; `content` is the fallback for tools without an
 * output schema. The SDK's `CallToolResultSchema.content` is a Zod default, so
 * omitting it is protocol-valid.
 *
 * This repository adds one constraint the raw SDK convention does not: because
 * `packages/result-bounds` deliberately bounds only the human-readable `text`
 * content while keeping `structuredContent` exact, the bounded text companion
 * is retained for eager hosts. The contract therefore standardizes on
 * `structuredContent` as the canonical result while marking the duplicate
 * bounded text payload as deprecated-once-hosts-surface-structured-output.
 */

export type ResultForm = "structured" | "content-only" | "ambiguous";

export function classifyResultForm(tool: CatalogTool): ResultForm {
  const hasOutput = tool.outputSchema !== undefined;
  const hasInput = tool.inputSchema !== undefined;
  if (hasOutput) return "structured";
  if (hasInput) return "content-only";
  return "ambiguous";
}

export interface ContractViolation {
  readonly tool: string;
  readonly reason: string;
}

/**
 * Enforce the declared half of the contract: every tool either declares an
 * output schema or is explicitly allowlisted as content-only. A tool with no
 * declared result shape is the "the server can't know which form the client
 * shows" hazard the 2026-07-28 roadmap calls out.
 */
export function contractViolations(
  catalog: Catalog,
  contentOnlyAllowlist: readonly string[],
): readonly ContractViolation[] {
  const violations: ContractViolation[] = [];
  for (const tool of catalog.tools) {
    const form = classifyResultForm(tool);
    if (form === "structured") continue;
    if (contentOnlyAllowlist.includes(tool.name)) continue;
    violations.push({
      tool: tool.name,
      reason:
        form === "content-only"
          ? "tool has inputSchema but no outputSchema and is not on the content-only allowlist"
          : "tool declares no result shape at all",
    });
  }
  return violations;
}

/** Canonical single-form result for new output-schema tools. */
export function canonicalResult<T extends Record<string, unknown>>(data: T): { structuredContent: T } {
  return { structuredContent: data };
}

export interface ResultShapePolicy {
  readonly canonical: "structuredContent";
  readonly deprecated: readonly string[];
}

export const RESULT_SHAPE_POLICY: ResultShapePolicy = {
  canonical: "structuredContent",
  deprecated: ["duplicate bounded text content when the host supports structuredContent"],
};