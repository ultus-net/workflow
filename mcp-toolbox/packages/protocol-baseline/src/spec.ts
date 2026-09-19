/**
 * Dated MCP 2026-07-28 protocol baseline for the toolbox.
 *
 * This is the single source of truth for "which 2026-07-28 features does the
 * vendored SDK actually support, and what did the toolbox do about each one".
 * It is deliberately machine-readable so the conformance smoke, the evidence
 * note, and the generated server cards all agree.
 *
 * Survey method: source inspection of the installed `@modelcontextprotocol/sdk`
 * (the version is asserted by `test/spec.test.ts` against the lockfile-resolved
 * package) plus the vendored type declarations. Honest-claims rule: a feature
 * is `native` only when the SDK exposes a public API for it; `partial` when the
 * SDK carries the wire types but no first-class server API; `absent` when the
 * SDK ships nothing and adopting it would mean hand-rolling a protocol layer,
 * which this repo does not do (see docs/AI_LANDSCAPE_RESEARCH.md §2).
 */

export const SPEC_VERSION = "2026-07-28" as const;
export const SURVEY_DATE = "2026-09-19" as const;

export type SdkSupport = "native" | "partial" | "absent";

export interface FeatureSurvey {
  readonly id:
    | "stateless-serving"
    | "server-discover"
    | "ttl-list-caching"
    | "tasks-extension"
    | "mrtr"
    | "tool-result-contract"
    | "cimd"
    | "enterprise-managed-authorization"
    | "server-cards";
  readonly title: string;
  readonly sdkSupport: SdkSupport;
  readonly sdkEvidence: string;
  readonly toolboxDisposition: string;
}

export const FEATURE_SURVEY: readonly FeatureSurvey[] = [
  {
    id: "stateless-serving",
    title: "Stateless core (SEP-2575/SEP-2567)",
    sdkSupport: "native",
    sdkEvidence:
      "StreamableHTTPServerTransport supports sessionIdGenerator: undefined (stateless mode); examples/server/simpleStatelessStreamableHttp.js ships in the SDK.",
    toolboxDisposition:
      "All toolbox products are stdio servers with no connection-local catalog or session identity. Catalog stability across independent processes is asserted by the conformance smoke; the task store is the only per-request state and is ephemeral.",
  },
  {
    id: "server-discover",
    title: "server/discover (capability discovery before initialize)",
    sdkSupport: "absent",
    sdkEvidence:
      "No server/discover request schema or method literal exists in the SDK dist (grep for 'server/discover' is empty); capability negotiation remains initialize/InitializeResult.",
    toolboxDisposition:
      "Not adopted. Hand-rolling the method would be a protocol layer outside the SDK; the equivalent capability payload is published in each product's Server Card and via initialize.",
  },
  {
    id: "ttl-list-caching",
    title: "TTL-cacheable list results (SEP-2549)",
    sdkSupport: "absent",
    sdkEvidence:
      "ListToolsResultSchema/ListResourcesResultSchema/ListPromptsResultSchema have no ttl field; the McpServer ListTools handler returns only { tools }.",
    toolboxDisposition:
      "Not adopted. Server-side list TTL is not expressible in SDK 1.30.0. Host-side definition caching is the documented alternative (tool-exposure-context-economics.md).",
  },
  {
    id: "tasks-extension",
    title: "Tasks extension (SEP-2663)",
    sdkSupport: "native",
    sdkEvidence:
      "experimental/tasks: ToolTaskHandler, TaskStore, InMemoryTaskStore, server.experimental.tasks.registerToolTask, tasks/get|list|cancel and notifications/tasks/status.",
    toolboxDisposition:
      "Adopted for one long-running lifecycle tool in verification-accountability-mcp; progress is visible through task status and existing logging notifications.",
  },
  {
    id: "mrtr",
    title: "Multi Round-Trip Requests (MRTR, SEP-2322)",
    sdkSupport: "partial",
    sdkEvidence:
      "Elicitation request/response and the TaskStatus 'input_required' state exist, but no SEP-2322 multi-round-trip envelope is present in the SDK.",
    toolboxDisposition:
      "Not adopted. The toolbox has no elicitation-style multi-turn flow (all tools are single-call, authority-backed, and non-interactive); recorded not-applicable rather than simulated.",
  },
  {
    id: "tool-result-contract",
    title: "One clear tool-result contract",
    sdkSupport: "native",
    sdkEvidence:
      "SDK convention: a tool with outputSchema must return structuredContent and clients surface that; CallToolResult.content is a ZodDefault array and may be omitted. validateToolOutput enforces structuredContent when outputSchema is declared.",
    toolboxDisposition:
      "Adopted as a declared contract: every tool declares a single outputSchema (or is on a documented content-only allowlist), and structuredContent is the canonical payload. The bounded text companion is retained as an eager-host fallback because packages/result-bounds deliberately bounds only text; see the evidence note for the deprecation path.",
  },
  {
    id: "cimd",
    title: "Client ID Metadata Documents (CIMD) registration",
    sdkSupport: "partial",
    sdkEvidence:
      "shared/auth OAuth metadata schemas expose client_id_metadata_document_supported; the SDK can advertise the capability but the hub-as-MCP-client path is stdio today.",
    toolboxDisposition:
      "Advertised-readiness only. No toolbox transport is HTTP/OAuth, so CIMD adoption is recorded as deferred with the W060 identity work (see evidence note); nothing is claimed live.",
  },
  {
    id: "enterprise-managed-authorization",
    title: "Enterprise-Managed Authorization (ID-JAG)",
    sdkSupport: "absent",
    sdkEvidence:
      "No ID-JAG / enterprise-managed authorization types or flows in SDK 1.30.0.",
    toolboxDisposition:
      "Deferred with a dated decision in the W058/W059 evidence note. Long-term ownership is W060 (agent identity); no federation implemented here.",
  },
  {
    id: "server-cards",
    title: "Server Cards (.well-known metadata)",
    sdkSupport: "absent",
    sdkEvidence:
      "No server-card schema or .well-known helper in SDK 1.30.0; the Server Card WG convention is not part of the SDK.",
    toolboxDisposition:
      "Adopted as a first-party generator: every product carries a generated .well-known/server-card.json derived from its compiled tools/list plus package.json, validated and drift-tested in pnpm run verify.",
  },
];

export function findFeature(id: FeatureSurvey["id"]): FeatureSurvey {
  const feature = FEATURE_SURVEY.find((entry) => entry.id === id);
  if (!feature) throw new Error(`unknown feature id: ${id}`);
  return feature;
}

export function surveySummary(): {
  readonly specVersion: string;
  readonly surveyDate: string;
  readonly counts: Readonly<Record<SdkSupport, number>>;
} {
  const counts: Record<SdkSupport, number> = { native: 0, partial: 0, absent: 0 };
  for (const feature of FEATURE_SURVEY) counts[feature.sdkSupport] += 1;
  return { specVersion: SPEC_VERSION, surveyDate: SURVEY_DATE, counts };
}