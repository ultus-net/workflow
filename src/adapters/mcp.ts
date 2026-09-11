import { evidenceId, observationId, type Evidence, type EvidenceResult } from "../kernel/contracts.js";

export interface McpCapability {
  readonly name: string;
  readonly description?: string;
}

export interface McpProvider {
  capabilities(): Promise<readonly McpCapability[]>;
  invoke(capability: string, input: unknown): Promise<unknown>;
}

interface McpEvidenceObservation {
  readonly observationId: string;
  readonly subject: string;
  readonly result: EvidenceResult;
  readonly observedAt: string;
}

export function normalizeMcpEvidence(input: unknown, mutationEpoch: number): Evidence {
  if (!isObservation(input)) {
    throw new TypeError("invalid MCP evidence observation");
  }
  if (!Number.isSafeInteger(mutationEpoch) || mutationEpoch < 0) {
    throw new TypeError("invalid mutation epoch");
  }

  return {
    id: evidenceId(`mcp:${input.observationId}`),
    observationId: observationId(input.observationId),
    authority: "mcp",
    subject: input.subject,
    result: input.result,
    freshness: "fresh",
    mutationEpoch,
    observedAt: input.observedAt,
  };
}

function isObservation(input: unknown): input is McpEvidenceObservation {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.observationId === "string" &&
    value.observationId.trim().length > 0 &&
    typeof value.subject === "string" &&
    value.subject.trim().length > 0 &&
    (value.result === "passed" || value.result === "failed") &&
    typeof value.observedAt === "string" &&
    !Number.isNaN(Date.parse(value.observedAt))
  );
}
