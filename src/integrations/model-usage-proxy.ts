import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  applyAutoRouterPlugin,
  createAliasResolver,
  isAutoRouterModel,
  type AliasResolver,
} from "./openrouter-auto-latest.js";
import { enforceReplayPolicy } from "./model-replay-policy.js";

export interface ModelUsageMetrics {
  readonly requests: number;
  readonly usageEvents: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly latestPromptTokens: number | undefined;
}

export interface ModelUsageProxy {
  /** Loopback base URL agents use as their provider baseUrl (no path suffix). */
  readonly url: string;
  readonly metrics: () => ModelUsageMetrics;
  readonly close: () => Promise<void>;
}

/** Placeholder credential agents receive; the proxy ignores it upstream. */
export const METERED_PLACEHOLDER_KEY = "workflow-metered";

/**
 * Cline `providers.json` content pointing a provider at the metering proxy.
 * Verified against Cline's StoredProviderSettings schema: `settings.baseUrl`
 * wins over provider defaults (explicit > apiLine > default), while the env
 * `CLINE_API_KEY` placeholder satisfies ACP `isSessionReady` — the real key
 * never enters the agent's environment or config files.
 */
export function meteredProviderSettings(proxyUrl: string, providerId = "openrouter"): Record<string, unknown> {
  return {
    version: 1,
    lastUsedProvider: providerId,
    modes: {},
    providers: {
      [providerId]: {
        settings: {
          provider: providerId,
          apiKey: METERED_PLACEHOLDER_KEY,
          baseUrl: `${proxyUrl}/api/v1`,
        },
        updatedAt: new Date().toISOString(),
        tokenSource: "manual",
      },
    },
  };
}

interface MutableMetrics {
  requests: number;
  usageEvents: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latestPromptTokens: number | undefined;
}

export interface AutoLatestProxyOptions {
  /** `~...-latest` aliases to resolve into the Auto Router pool. */
  readonly aliases: readonly string[];
  /** Optional Auto Router cost band (`low`..`max`). */
  readonly costTier?: string;
  /** Model catalog URL; defaults to `<upstream>/api/v1/models`. */
  readonly modelsUrl?: string;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
  /** Injectable for tests. */
  readonly now?: () => number;
  /** Cache lifetime for resolved aliases. */
  readonly ttlMs?: number;
  /** Backoff after a failed catalog fetch; defaults to 1 minute. */
  readonly negativeTtlMs?: number;
}

/**
 * Hub-owned metering proxy for model traffic. The upstream provider key lives
 * ONLY here: agents receive a placeholder key and a baseUrl pointing at this
 * proxy, which strips inbound credentials, injects the real key, and records
 * token/cost usage from responses. Chat-completion requests are rewritten to
 * ask the provider for usage accounting so usage is present even in SSE
 * streams. The proxy binds loopback only.
 */
export async function createModelUsageProxy(options: {
  readonly upstream: string;
  readonly apiKey: string;
  readonly onUsage?: (usage: Record<string, unknown>) => void;
  /**
   * When set, chat completions targeting `openrouter/auto` have the resolved
   * `~...-latest` pool injected as the Auto Router `allowed_models` before
   * forwarding. Absent leaves traffic untouched.
   */
  readonly autoLatest?: AutoLatestProxyOptions | undefined;
}): Promise<ModelUsageProxy> {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new TypeError("model usage proxy requires a non-empty upstream API key");
  }
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "https:" && upstream.hostname !== "localhost" && upstream.hostname !== "127.0.0.1") {
    throw new TypeError("model usage proxy upstream must be https (or loopback for tests)");
  }
  const metrics: MutableMetrics = { requests: 0, usageEvents: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, latestPromptTokens: undefined };
  const autoLatest = options.autoLatest;
  const aliasResolver: AliasResolver | undefined =
    autoLatest === undefined
      ? undefined
      : createAliasResolver({
          modelsUrl: autoLatest.modelsUrl ?? new URL("/api/v1/models", upstream).toString(),
          aliases: autoLatest.aliases,
          ...(autoLatest.fetch === undefined ? {} : { fetch: autoLatest.fetch }),
          ...(autoLatest.now === undefined ? {} : { now: autoLatest.now }),
          ...(autoLatest.ttlMs === undefined ? {} : { ttlMs: autoLatest.ttlMs }),
          ...(autoLatest.negativeTtlMs === undefined ? {} : { negativeTtlMs: autoLatest.negativeTtlMs }),
        });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `model usage proxy upstream failure: ${error instanceof Error ? error.message : String(error)}` }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    metrics.requests += 1;
    const inbound = await readAll(req);
    const isCompletions = req.method === "POST" && typeof req.url === "string" && /\/chat\/completions$/.test(req.url);
    let outboundBody = inbound;
    if (isCompletions && inbound.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(inbound.toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model usage proxy received malformed JSON chat completion body" }));
        return;
      }
      if (!isRecord(parsed)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "model usage proxy received non-object chat completion body" }));
        return;
      }
      // W070b slice 1: enforce the model's assistant-message replay policy at
      // the wire boundary. K3 is rejected on a stripped replay; DeepSeek
      // synthesized tool-call turns are diverted to the Anthropic path. This
      // is harness correctness — it rejects malformed replays, it does not
      // guarantee model behavior.
      const replay = enforceReplayPolicy(parsed);
      if (replay.action === "reject") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: replay.reason, policy: replay.policy.family, violations: replay.violations }));
        return;
      }
      if (replay.action === "route-anthropic") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: replay.reason, policy: replay.policy.family, violations: replay.violations }));
        return;
      }
      // Hub-owned Auto Router pool: resolve `~...-latest` aliases to concrete
      // slugs and inject them so the router's `allowed_models` (which does not
      // understand aliases) actually has candidates. Fail open on resolution
      // failure so traffic is never blocked by a catalog hiccup.
      let routed = parsed;
      if (aliasResolver !== undefined && isAutoRouterModel(parsed.model)) {
        const allowedModels = await aliasResolver.resolve();
        if (allowedModels.length > 0) {
          routed = applyAutoRouterPlugin(parsed, parsed.model, allowedModels, autoLatest?.costTier);
        }
      }
      const existing = isRecord(routed.usage) ? routed.usage : {};
      // Ask the provider for usage accounting so usage arrives even in streams.
      outboundBody = Buffer.from(JSON.stringify({ ...routed, usage: { ...existing, include: true } }), "utf8");
    }

    // P1: reject absolute-form request-targets — RFC 7230 allows
    // `GET http://attacker/...` which would make new URL(absolute, base)
    // ignore the upstream and exfiltrate the injected Bearer key.
    const target = new URL(req.url ?? "/", upstream);
    if (target.origin !== upstream.origin) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model usage proxy only forwards origin-form request targets" }));
      return;
    }
    const response = await fetch(target, {
      method: req.method ?? "GET",
      headers: scrubRequestHeaders(req.headers, options.apiKey, outboundBody.length),
      body: req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(outboundBody),
      redirect: "manual",
      signal: AbortSignal.timeout(300_000),
    });

    const contentType = response.headers.get("content-type") ?? "";
    res.writeHead(response.status, forwardedResponseHeaders(response, contentType));
    if (contentType.includes("text/event-stream") && response.body !== null) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined && value.length > 0) {
          res.write(Buffer.from(value));
          buffered += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, index).trim();
            buffered = buffered.slice(index + 1);
            recordSseLine(line);
          }
        }
      }
      recordSseLine(buffered.trim());
      res.end();
      return;
    }
    const text = await response.text();
    recordJsonUsage(text);
    res.end(text);
  }

  function recordSseLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") return;
    try {
      recordUsage(JSON.parse(data));
    } catch {
      // Non-JSON SSE chunk; ignore for metering.
    }
  }

  function recordJsonUsage(text: string): void {
    try {
      recordUsage(JSON.parse(text));
    } catch {
      // Non-JSON body; nothing to meter.
    }
  }

  function recordUsage(payload: unknown): void {
    if (!isRecord(payload)) return;
    const usage = payload.usage;
    if (!isRecord(usage)) return;
    metrics.usageEvents += 1;
    metrics.promptTokens += numberOrZero(usage.prompt_tokens);
    metrics.completionTokens += numberOrZero(usage.completion_tokens);
    metrics.totalTokens += numberOrZero(usage.total_tokens);
    metrics.costUsd += numberOrZero(usage.cost);
    if (typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)) {
      metrics.latestPromptTokens = usage.prompt_tokens;
    }
    options.onUsage?.(usage);
  }

  // Warm the alias cache so the first Auto Router request does not wait on the
  // catalog fetch. Fire-and-forget: failure is handled inside the resolver.
  if (aliasResolver !== undefined) void aliasResolver.resolve();

  const started = await new Promise<AddressInfo>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectServer(new Error("model usage proxy failed to bind"));
        return;
      }
      resolveServer(address);
    });
  });

  return {
    url: `http://127.0.0.1:${started.port}`,
    metrics: () => ({ ...metrics }),
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

// RFC 7230 §6.1 hop-by-hop headers are connection-scoped and must never be
// forwarded; `authorization` is replaced with the real key, `content-length`
// is recomputed for the rewritten body, and `accept-encoding` is forced to
// identity so SSE/JSON bodies stay parseable for metering.
const HOP_BY_HOP_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

function scrubRequestHeaders(headers: http.IncomingHttpHeaders, apiKey: string, contentLength: number): Record<string, string> {
  // The Connection header may additionally name sender-specific hop-by-hop
  // headers; those must be stripped too.
  const connectionTokens = new Set<string>();
  const connectionValue = headers.connection;
  for (const entry of Array.isArray(connectionValue) ? connectionValue : [connectionValue]) {
    if (typeof entry !== "string") continue;
    for (const token of entry.split(",")) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed.length > 0) connectionTokens.add(trimmed);
    }
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  result.authorization = `Bearer ${apiKey}`;
  result["content-length"] = String(contentLength);
  // Identity keeps SSE/JSON bodies parseable for metering.
  result["accept-encoding"] = "identity";
  return result;
}

// End-to-end upstream headers worth surfacing to the agent so provider
// signaling (retries, rate limits, redirects) survives the passthrough.
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after", "location"];

function forwardedResponseHeaders(response: Response, contentType: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null && value.length > 0) result[name] = value;
  }
  for (const [name, value] of response.headers.entries()) {
    if (name.startsWith("x-ratelimit-")) result[name] = value;
  }
  result["content-type"] = contentType || "application/octet-stream";
  return result;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAll(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolveRead(Buffer.concat(chunks)));
    stream.on("error", rejectRead);
  });
}
