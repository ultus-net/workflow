import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";

/**
 * W071 — the OpenCode server gateway.
 *
 * A loopback reverse proxy in front of a Workflow-launched `opencode serve`.
 * It exists to make the hub the SOLE upstream permission answerer
 * structurally, not by race (plan §3): the client (the stock TUI) holds a
 * distinct gateway password; the upstream server password is hub-only. A
 * client reply to the permission route is either handed to the broker hook
 * (enforced posture, M2) or passed through upstream (advisory posture); it is
 * never forwarded as a client credential.
 *
 * Fidelity requirements pinned by the M0 probe (docs/OPENCODE_SERVER_AUTHORITY.md):
 * `opencode serve` returns gzipped JSON, so response `content-encoding` must be
 * forwarded; clients send `?directory=`, so routes must match on the pathname.
 */

export type OpencodePermissionReplyValue = "once" | "always" | "reject";

export interface OpencodePermissionReply {
  readonly sessionId: string;
  readonly requestId: string;
  readonly reply: OpencodePermissionReplyValue;
}

export interface OpencodeServerGatewayOptions {
  /** Upstream server base URL, e.g. `http://127.0.0.1:4096`. */
  readonly upstream: string;
  readonly upstreamUsername?: string | undefined;
  /** Hub-only upstream credential. Never exposed to the client. */
  readonly upstreamPassword: string;
  readonly tuiUsername?: string | undefined;
  /** Client-facing credential. Distinct from the upstream password. */
  readonly tuiPassword: string;
  /**
   * Broker hook. When present, permission replies are intercepted and handed
   * to the hook (the enforced posture). When absent, replies are passed
   * through upstream (advisory: the client is the answerer).
   */
  readonly onPermissionReply?: ((reply: OpencodePermissionReply) => Promise<void> | void) | undefined;
  /**
   * Enforced posture (plan M3): the client must never be able to answer
   * upstream, so a broker hook is mandatory. Construction fails closed when
   * `enforced` is set without one.
   */
  readonly enforced?: boolean | undefined;
  /** Observation hook for tests/hub monitors. */
  readonly observedRequest?: ((path: string) => void) | undefined;
}

export interface OpencodeServerGateway {
  readonly url: string;
  /** The client-facing password (safe to publish to the launcher discovery). */
  readonly password: string;
  close(): Promise<void>;
}

const REPLY_ROUTE = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/;
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export async function createOpencodeServerGateway(
  options: OpencodeServerGatewayOptions,
): Promise<OpencodeServerGateway> {
  if (options.enforced === true && options.onPermissionReply === undefined) {
    // Enforced means singular authority: without the broker hook the client
    // would be the answerer, so refuse to build such a gateway.
    throw new TypeError("an enforced gateway requires the broker hook (onPermissionReply)");
  }
  const upstream = new URL(options.upstream);
  const upstreamAuth = basic(options.upstreamUsername ?? "opencode", options.upstreamPassword);
  const server = createServer((request, response) => {
    // Error boundary (review P2-3): a throw on the request path must fail
    // closed with a 500, never crash the daemon and orphan the server.
    handle(request, response, upstream, upstreamAuth, options).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "gateway handler failure" });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("OpenCode server gateway could not bind a loopback port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    password: options.tuiPassword,
    close: () => closeServer(server),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: URL,
  upstreamAuth: string,
  options: OpencodeServerGatewayOptions,
): Promise<void> {
  const supplied = decodeBasic(request.headers.authorization);
  const expected = `${options.tuiUsername ?? "opencode"}:${options.tuiPassword}`;
  if (supplied === undefined || !equalConstantTime(supplied, expected)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  const rawPathname = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  const pathname = decodedPathname(rawPathname);
  options.observedRequest?.(pathname);
  const reply = request.method === "POST" ? REPLY_ROUTE.exec(pathname) : null;
  if (reply !== null) {
    if (options.onPermissionReply !== undefined) {
      await handlePermissionReply(request, response, options, reply[1]!, reply[2]!);
      return;
    }
    // Advisory posture: no broker authority yet; the client reply is the
    // answerer, so it passes through. The surface must not be labeled
    // enforced in this mode.
  } else if (request.method === "POST" && isReplyShapedPathname(pathname)) {
    // A reply-shaped path that does not map cleanly must never be forwarded
    // upstream under the hub credential (review P1-2: fail closed).
    sendJson(response, 400, { error: "unmappable permission reply path" });
    return;
  }
  forward(request, response, upstream, upstreamAuth);
}

/** Decodes percent-escapes so `/…/%72eply` cannot dodge the reply-route match. */
function decodedPathname(rawPathname: string): string {
  try {
    return decodeURIComponent(rawPathname);
  } catch {
    return rawPathname;
  }
}

function isReplyShapedPathname(pathname: string): boolean {
  return pathname.includes("/permission/") && (pathname.endsWith("/reply") || pathname.includes("/reply?"));
}

async function handlePermissionReply(
  request: IncomingMessage,
  response: ServerResponse,
  options: OpencodeServerGatewayOptions,
  sessionId: string,
  requestId: string,
): Promise<void> {
  const hook = options.onPermissionReply;
  if (hook === undefined) return; // Unreachable: only broker mode routes here.
  let body: unknown;
  try {
    body = await readJson(request, 64 * 1024);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid permission reply" });
    return;
  }
  if (!isRecord(body) || !isReplyValue(body.reply)) {
    sendJson(response, 400, { error: "invalid permission reply" });
    return;
  }
  try {
    await hook({ sessionId, requestId, reply: body.reply });
  } catch (error) {
    // A broker failure fails closed: the reply is not forwarded and the client
    // sees the failure rather than an implicit allow.
    sendJson(response, 502, { error: `broker rejected the reply: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  sendJson(response, 200, {});
}

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: URL,
  upstreamAuth: string,
): void {
  const incoming = new URL(request.url ?? "/", "http://gateway.invalid");
  const target = new URL(upstream.toString());
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (value === undefined || lower === "authorization" || lower === "host" || HOP_BY_HOP.has(lower)) continue;
    headers[key] = value;
  }
  headers["authorization"] = upstreamAuth;
  headers["host"] = upstream.host;

  const proxied = httpRequest(target, { method: request.method ?? "GET", headers }, (upstreamResponse) => {
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      const lower = key.toLowerCase();
      if (value === undefined || HOP_BY_HOP.has(lower)) continue;
      responseHeaders[key] = value;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  proxied.on("error", () => {
    if (!response.headersSent) sendJson(response, 502, { error: "gateway upstream unreachable" });
    else response.destroy();
  });
  request.pipe(proxied);
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function decodeBasic(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Basic\s+(.+)$/.exec(header);
  if (match === null) return undefined;
  try {
    return Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function equalConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isReplyValue(value: unknown): value is OpencodePermissionReplyValue {
  return value === "once" || value === "always" || value === "reject";
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > limit) throw new Error("gateway request is too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() === "" ? undefined : JSON.parse(text);
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

/** Generates a per-gateway client password (published only via the discovery file). */
export function newTuiPassword(): string {
  return randomBytes(24).toString("hex");
}