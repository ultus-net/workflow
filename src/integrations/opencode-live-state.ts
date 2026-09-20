import {
  opencodeServerDiscoveryPath,
  probeOpencodeServerGateway,
  readOpencodeServerDiscovery,
} from "./opencode-server-discovery.js";

/**
 * W074 follow-up (dual-lane, 2026-09-20): live MCP state from the documented
 * v2 data lane. When the Workflow-owned opencode server topology is running
 * for a workspace (the TUI/hub daemon), its enforced gateway can answer
 * `GET /api/mcp` — the live, server-side MCP state that ACP structurally does
 * not expose (the ACP lane stays the control lane; this is observation only).
 *
 * The client credential from the discovery file (the TUI password, deliberately
 * the client-facing one) authorizes the read; the upstream credential is never
 * read here. Failures are honest states, never fabricated connections.
 */

export interface LiveMcpServer {
  readonly name: string;
  readonly status: string;
}

export type LiveMcpState =
  | { readonly live: true; readonly gatewayUrl: string; readonly servers: readonly LiveMcpServer[] }
  | { readonly live: false; readonly reason: string };

export interface LiveStateOptions {
  readonly workspace: string;
  readonly stateHome: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function fetchLiveMcp(options: LiveStateOptions): Promise<LiveMcpState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const discovery = readOpencodeServerDiscovery(opencodeServerDiscoveryPath(options.stateHome, options.workspace));
  if (discovery === undefined) {
    return { live: false, reason: "no server topology daemon is running for this workspace" };
  }
  try {
    if (new URL(discovery.gatewayUrl).hostname !== "127.0.0.1" && new URL(discovery.gatewayUrl).hostname !== "localhost" && new URL(discovery.gatewayUrl).hostname !== "::1") {
      return { live: false, reason: "discovery refused: the gateway is not loopback" };
    }
  } catch {
    return { live: false, reason: "discovery refused: malformed gateway URL" };
  }
  if (!(await probeOpencodeServerGateway(discovery, fetchImpl))) {
    return { live: false, reason: "the gateway did not answer (stale discovery or the daemon stopped)" };
  }
  const auth = `Basic ${Buffer.from(`${discovery.tuiUsername}:${discovery.tuiPassword}`).toString("base64")}`;
  let response: Response;
  try {
    response = await fetchImpl(`${discovery.gatewayUrl}/api/mcp`, { headers: { authorization: auth }, signal: AbortSignal.timeout(4_000) });
  } catch (error) {
    return { live: false, reason: `the live MCP read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) {
    return { live: false, reason: `the gateway refused the live MCP read (${response.status})` };
  }
  const body = await response.json().catch(() => undefined) as { data?: unknown } | undefined;
  if (body === undefined || !Array.isArray(body.data)) {
    return { live: false, reason: "the live MCP read returned an unexpected shape" };
  }
  // Defensive mapping: the documented envelope is { data: Mcp.Server[] } with
  // status variants (connected/disabled/failed/needs-auth/pending); unknown
  // shapes degrade to "unknown", never to a fabricated connection.
  const servers: LiveMcpServer[] = body.data.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (name === undefined) return [];
    const rawStatus = record.status;
    const status = typeof rawStatus === "string"
      ? rawStatus
      : typeof rawStatus === "object" && rawStatus !== null && typeof (rawStatus as Record<string, unknown>).type === "string"
        ? String((rawStatus as Record<string, unknown>).type)
        : "unknown";
    return [{ name, status }];
  });
  return { live: true, gatewayUrl: discovery.gatewayUrl, servers };
}