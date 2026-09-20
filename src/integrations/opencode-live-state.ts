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
  const gateway = await resolveLiveGateway(options, "live MCP");
  if (!gateway.ok) return { live: false, reason: gateway.reason };
  let response: Response;
  try {
    response = await gateway.fetchImpl(`${gateway.gatewayUrl}/api/mcp`, { headers: { authorization: gateway.auth }, signal: AbortSignal.timeout(4_000) });
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
  return { live: true, gatewayUrl: gateway.gatewayUrl, servers };
}

export interface LiveSessionStats {
  readonly sessions: number;
  readonly prompts: number;
  readonly steps: number;
  readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly cost: number;
  readonly tools: { readonly calls: number; readonly succeeded: number; readonly failed: number; readonly unfinished: number };
}

export type LiveStatsState =
  | { readonly live: true; readonly gatewayUrl: string; readonly stats: LiveSessionStats }
  | { readonly live: false; readonly reason: string };

/** Walks discovery → loopback check → gateway probe → the resolved gateway.
 * The single honest gate both live reads share; every unavailable outcome is
 * an explicit reason, never a fabricated connection. */
async function resolveLiveGateway(options: LiveStateOptions, what: string): Promise<
  { readonly ok: true; readonly gatewayUrl: string; readonly auth: string; readonly fetchImpl: typeof fetch }
  | { readonly ok: false; readonly reason: string }
> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const discovery = readOpencodeServerDiscovery(opencodeServerDiscoveryPath(options.stateHome, options.workspace));
  if (discovery === undefined) {
    return { ok: false, reason: `no server topology daemon is running for this workspace (${what} unavailable)` };
  }
  try {
    const hostname = new URL(discovery.gatewayUrl).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      return { ok: false, reason: "discovery refused: the gateway is not loopback" };
    }
  } catch {
    return { ok: false, reason: "discovery refused: malformed gateway URL" };
  }
  if (!(await probeOpencodeServerGateway(discovery, fetchImpl))) {
    return { ok: false, reason: "the gateway did not answer (stale discovery or the daemon stopped)" };
  }
  return {
    ok: true,
    gatewayUrl: discovery.gatewayUrl,
    auth: `Basic ${Buffer.from(`${discovery.tuiUsername}:${discovery.tuiPassword}`).toString("base64")}`,
    fetchImpl,
  };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Operator-triggered manual compaction (W082): the documented
 * `POST /api/session/{sessionID}/compact` — the HTTP twin of the TUI's
 * /compact slash command. Per the documented contract the route durably
 * ADMITS a compaction request (`{ data: Session.Inbox.Compaction }`): the
 * summarization runs at the session's next step boundary, so the honest
 * result is "queued", never "summarized now". The sessionId is the AGENT's
 * v2 session id (the ACP driver's agent session, `^ses`), not the Workflow
 * session id. Same fail-closed gateway walk as the other live reads. */
export type LiveCompactionState =
  | { readonly compacted: true; readonly gatewayUrl: string; readonly inboxId: string | undefined }
  | { readonly compacted: false; readonly reason: string };

export async function compactSession(options: LiveStateOptions & { readonly sessionId: string }): Promise<LiveCompactionState> {
  const sessionId = options.sessionId.trim();
  if (!/^ses\S*$/.test(sessionId)) {
    return { compacted: false, reason: "no agent session id — the focused session has no opencode runtime session to compact" };
  }
  const gateway = await resolveLiveGateway(options, "compaction");
  if (!gateway.ok) return { compacted: false, reason: gateway.reason };
  let response: Response;
  try {
    response = await gateway.fetchImpl(`${gateway.gatewayUrl}/api/session/${encodeURIComponent(sessionId)}/compact`, {
      method: "POST",
      headers: { authorization: gateway.auth },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { compacted: false, reason: `the compaction request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) {
    // Surface the server's own message when the error envelope carries one
    // (e.g. compaction.unavailable "Nothing to compact yet", or the documented
    // overflow 400 telling the operator the same thing).
    const body = await response.json().catch(() => undefined) as { data?: { message?: unknown } | undefined; message?: unknown } | undefined;
    const message = typeof body?.data?.message === "string" ? body.data.message : typeof body?.message === "string" ? body.message : undefined;
    return { compacted: false, reason: `the gateway refused the compaction request (${response.status})${message === undefined ? "" : `: ${message}`}` };
  }
  const accepted = await response.json().catch(() => undefined) as { data?: { id?: unknown } | undefined } | undefined;
  const inboxId = typeof accepted?.data?.id === "string" ? accepted.data.id : undefined;
  return { compacted: true, gatewayUrl: gateway.gatewayUrl, inboxId };
}

/** Live session statistics (W079): the documented aggregate
 * `GET /api/experimental/session/stats` — server-side activity, usage, and
 * tool reliability for the topology the hub owns. Same honest contract as the
 * live MCP read. */
export async function fetchSessionStats(options: LiveStateOptions): Promise<LiveStatsState> {
  const gateway = await resolveLiveGateway(options, "session stats");
  if (!gateway.ok) return { live: false, reason: gateway.reason };
  let response: Response;
  try {
    response = await gateway.fetchImpl(`${gateway.gatewayUrl}/api/experimental/session/stats`, { headers: { authorization: gateway.auth }, signal: AbortSignal.timeout(4_000) });
  } catch (error) {
    return { live: false, reason: `the session-stats read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) {
    return { live: false, reason: `the gateway refused the session-stats read (${response.status})` };
  }
  const body = await response.json().catch(() => undefined) as { data?: unknown } | undefined;
  if (body === undefined || typeof body.data !== "object" || body.data === null) {
    return { live: false, reason: "the session-stats read returned an unexpected shape" };
  }
  const record = body.data as Record<string, unknown>;
  const tokens = typeof record.tokens === "object" && record.tokens !== null ? (record.tokens as Record<string, unknown>) : undefined;
  const cache = typeof tokens?.cache === "object" && tokens.cache !== null ? (tokens.cache as Record<string, unknown>) : undefined;
  const toolsRecord = typeof record.tools === "object" && record.tools !== null ? (record.tools as Record<string, unknown>) : undefined;
  const toolTotals = typeof toolsRecord?.totals === "object" && toolsRecord.totals !== null ? (toolsRecord.totals as Record<string, unknown>) : undefined;
  return {
    live: true,
    gatewayUrl: gateway.gatewayUrl,
    stats: {
      sessions: numeric(record.sessions),
      prompts: numeric(record.prompts),
      steps: numeric(record.steps),
      tokens: {
        input: numeric(tokens?.input),
        output: numeric(tokens?.output),
        reasoning: numeric(tokens?.reasoning),
        cacheRead: numeric(cache?.read),
        cacheWrite: numeric(cache?.write),
      },
      cost: numeric(record.cost),
      tools: {
        calls: numeric(toolTotals?.calls),
        succeeded: numeric(toolTotals?.succeeded),
        failed: numeric(toolTotals?.failed),
        unfinished: numeric(toolTotals?.unfinished),
      },
    },
  };
}