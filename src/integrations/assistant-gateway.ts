import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import { METERED_PLACEHOLDER_KEY } from "./egress-credential.js";
import type { ModelUsageMetrics } from "./model-usage-proxy.js";

/**
 * W192 (assistant gateway, M1): the assistant gateway lane.
 *
 * An OpenAI-compatible endpoint that binds an IDENTITY to a ROUTE POLICY and
 * injects a per-route system prompt before forwarding. It deliberately has NO
 * tools and does NOT call `authorize()`: M1 only establishes the identity →
 * route → system-prompt binding and the metered egress path. The metering,
 * egress policy, and credential injection are NOT re-implemented here — the
 * transformed body is forwarded to the existing metered loopback proxy
 * (`createModelUsageProxy`), so metering/egress/credential apply unchanged.
 *
 * The front door attaches through {@link handleAssistantRequest}: a route the
 * gateway answers itself rather than forwarding, mirroring the authority-route
 * pattern in `opencode-server-gateway.ts` `handle()`.
 */

/** The closed set of assistant routes. Config may only name these. */
export type AssistantRoute = "coding" | "tutor" | "care";

/** The three route names, in declaration order, as a runtime value. */
const ASSISTANT_ROUTES = ["coding", "tutor", "care"] as const;

export interface AssistantRoutePolicy {
  readonly route: AssistantRoute;
  /** System prompt injected (prepended as a system message) for this route. */
  readonly systemPrompt: string;
}

export interface AssistantGatewayConfig {
  /** version for forward-compat (config is policy; keep it diffable). */
  readonly version: 1;
  /** identity (LibreChat userId or Discord snowflake) -> route */
  readonly identities: Readonly<Record<string, AssistantRoute>>;
  readonly routes: Readonly<Record<AssistantRoute, AssistantRoutePolicy>>;
}

/** The identity header (LibreChat userId or Discord snowflake). Lowercase: Node lowercases incoming header names. */
export const ASSISTANT_IDENTITY_HEADER = "x-workflow-user";

/**
 * The config's wire schema. Policy, not mechanism: an unknown route name, a
 * missing route, or an identity bound to a route absent from `routes` all fail
 * closed (a thrown `ZodError`, surfaced by {@link loadAssistantGatewayConfig}).
 */
const AssistantRouteSchema = z.enum(ASSISTANT_ROUTES);

const AssistantRoutePolicySchema = z.object({
  route: AssistantRouteSchema,
  systemPrompt: z.string(),
});

const AssistantGatewayConfigSchema = z
  .object({
    version: z.literal(1),
    identities: z.record(z.string(), AssistantRouteSchema),
    routes: z.record(z.string(), AssistantRoutePolicySchema),
  })
  .superRefine((config, context) => {
    // Only the three route names are accepted as keys.
    for (const key of Object.keys(config.routes)) {
      if (!(ASSISTANT_ROUTES as readonly string[]).includes(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `unknown route: ${key}` });
      }
    }
    // All three routes must be present (the config is total over the route set).
    for (const route of ASSISTANT_ROUTES) {
      if (config.routes[route] === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `missing route policy: ${route}` });
      }
    }
    // Every identity must map to a route that has a policy.
    for (const [identity, route] of Object.entries(config.identities)) {
      if (config.routes[route] === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `identity ${identity} maps to unknown route ${route}` });
      }
    }
  });

/** Load + validate the route config from a JSON file (fail closed). */
export function loadAssistantGatewayConfig(path: string): AssistantGatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`assistant gateway config could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`assistant gateway config at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = AssistantGatewayConfigSchema.parse(raw);
  // Rebuild the total route map explicitly: the schema guarantees all three
  // keys, but the inferred type carries a string index signature, so this is
  // where the config is narrowed to the declared `Record<AssistantRoute, ...>`.
  const routes = {} as Record<AssistantRoute, AssistantRoutePolicy>;
  for (const route of ASSISTANT_ROUTES) {
    routes[route] = parsed.routes[route]!;
  }
  return { version: 1, identities: parsed.identities, routes };
}

export interface AssistantGateway {
  readonly url: string;
  readonly metrics: () => ModelUsageMetrics;
  readonly close: () => Promise<void>;
}

/**
 * Standalone server factory. `egress` is the metered loopback proxy the gateway
 * forwards transformed bodies to. `egressUrl` is its base (no path suffix).
 */
export async function createAssistantGateway(options: {
  readonly egressUrl: string;
  readonly egressMetrics: () => ModelUsageMetrics;
  readonly config: AssistantGatewayConfig;
  readonly host?: string;
  readonly port?: number;
}): Promise<AssistantGateway> {
  const server = createServer((request, response) => {
    // Error boundary: a throw on the request path fails closed with a 502,
    // never crashes the daemon and orphans the server.
    handleAssistantRequest(request, response, { egressUrl: options.egressUrl, config: options.config }).catch(() => {
      if (!response.headersSent) sendJson(response, 502, { error: { message: "assistant gateway handler failure", type: "api_error" } });
      else response.destroy();
    });
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("assistant gateway could not bind a loopback port");
  }
  return {
    url: `http://${host}:${address.port}`,
    metrics: options.egressMetrics,
    close: () => closeServer(server),
  };
}

/**
 * Pure dispatch for the front door. Returns true when it handled the request
 * (an assistant lane), false when the caller should continue its own dispatch.
 * Mirrors the authority-route pattern in opencode-server-gateway.ts.
 */
export async function handleAssistantRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  deps: { readonly egressUrl: string; readonly config: AssistantGatewayConfig },
): Promise<boolean> {
  // 1. Only `POST .../chat/completions` belongs to this lane; everything else
  // is the caller's to dispatch.
  const method = (request.method ?? "").toUpperCase();
  const pathname = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  if (method !== "POST" || !pathname.endsWith("/chat/completions")) return false;

  // 2. Identity → route. A missing or unbound identity fails closed with a 403
  // and STILL returns true: this is the assistant lane, it must not fall
  // through to another dispatcher that might forward the request unmetered.
  const identity = headerValue(request.headers[ASSISTANT_IDENTITY_HEADER]);
  const route = identity === undefined ? undefined : deps.config.identities[identity];
  if (route === undefined) {
    sendJson(response, 403, { error: { message: "unknown assistant identity", type: "invalid_request_error" } });
    return true;
  }
  const policy = deps.config.routes[route];

  // 3. Parse the body and inject the route's system prompt. A malformed body
  // fails closed 400.
  let raw: Buffer;
  try {
    raw = await readAll(request);
  } catch {
    sendJson(response, 400, { error: { message: "invalid JSON body" } });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    sendJson(response, 400, { error: { message: "invalid JSON body" } });
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(response, 400, { error: { message: "invalid JSON body" } });
    return true;
  }
  // PREPEND a new system message; never merge with an existing one. Every other
  // body field (model, stream, temperature, tools, ...) is preserved.
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const transformed = {
    ...parsed,
    messages: [{ role: "system", content: policy.systemPrompt }, ...messages],
  };

  // 4. Forward the transformed body to the metered loopback proxy. We set the
  // placeholder authorization the proxy expects (it injects the real key).
  const headers: Record<string, string> = { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` };
  const contentType = headerValue(request.headers["content-type"]);
  if (contentType !== undefined) headers["content-type"] = contentType;
  const accept = headerValue(request.headers.accept);
  if (accept !== undefined) headers.accept = accept;

  let upstream: Response;
  try {
    upstream = await fetch(`${deps.egressUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(transformed),
    });
  } catch (error) {
    sendJson(response, 502, { error: { message: `assistant gateway egress unreachable: ${error instanceof Error ? error.message : String(error)}`, type: "api_error" } });
    return true;
  }
  // 5. Stream the upstream response back: copy status and headers, then pipe
  // the body — works for both buffered JSON and SSE.
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "transfer-encoding" || lower === "content-encoding" || lower === "connection") return;
    responseHeaders[lower] = value;
  });
  response.writeHead(upstream.status, responseHeaders);
  if (upstream.body === null) {
    response.end();
    return true;
  }
  // A `ReadableStream` from `fetch` (undici's WHATWG type) and Node's
  // `node:stream/web` type are structurally identical but nominally distinct to
  // tsc, so the body is cast at this one boundary.
  await pipeline(Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream), response);
  return true;
}

/** Reads a request body as bytes. */
async function readAll(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Normalizes a possibly-array header value to a single string. */
function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : undefined;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
