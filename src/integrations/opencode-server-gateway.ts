import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";

import {
  OPENCODE_V2_PERMISSION_REPLY_ROUTE,
  qualifyOpenCodeV2Route,
} from "./opencode-v2-route-class.js";

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
  /** Observation hook for the event-stream keepalive timer (tests/monitors). */
  readonly observedKeepalive?: ((event: OpencodeSseKeepaliveEvent) => void) | undefined;
  /**
   * C1 plane bind. Defaults to an ephemeral loopback port (`127.0.0.1:0`) —
   * byte-identical to the pre-C1 behavior. The plane supervisor sets
   * `{ host: "0.0.0.0", port: 4096 }` so the gateway is the single ingress
   * front door. A non-loopback host binds a public surface and must never be
   * a silent default.
   */
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

/**
 * The keepalive timer lifecycle: `armed` = a timer is pending, `fired` = a
 * frame was written, `cleared` = a pending timer was dropped without a write.
 * A timer is either fired or cleared, never both, and never left pending —
 * so `armed === fired + cleared` once the stream is gone.
 */
export type OpencodeSseKeepaliveEvent = "armed" | "fired" | "cleared";

export interface OpencodeServerGateway {
  readonly url: string;
  /** The client-facing password (safe to publish to the launcher discovery). */
  readonly password: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

/**
 * Event-stream keepalive. An ingress proxy with a ~4-minute idle timeout
 * closes a quiet `text/event-stream` response, and the attached session dies
 * with it, so the gateway emits an SSE comment frame while the stream is
 * silent. A comment frame carries no `event:`/`data:` field, so a conforming
 * parser ignores it: the client sees byte activity, never a phantom event.
 *
 * ADVISORY: this is transport-level liveness only. It is not evidence that
 * upstream is alive or that the hub is the authority — it holds a connection
 * open, and nothing more.
 */
export const DEFAULT_SSE_KEEPALIVE_MS = 15_000;
/** Exported so the infra/c0 recipe doc can be pinned to the real frame. */
export const SSE_KEEPALIVE_FRAME = ": workflow-keepalive\n\n";

/** WORKFLOW_SSE_KEEPALIVE_MS must be a positive integer; anything else keeps the default. */
export function sseKeepaliveMs(env: NodeJS.ProcessEnv): number {
  const raw = env.WORKFLOW_SSE_KEEPALIVE_MS;
  if (raw === undefined) return DEFAULT_SSE_KEEPALIVE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_SSE_KEEPALIVE_MS;
  return parsed;
}

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
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("OpenCode server gateway could not bind a loopback port");
  }
  return {
    // A non-loopback bind is advertised by its literal host so the plane can
    // report the real front-door address; the loopback default keeps the
    // historical `127.0.0.1:<port>` URL.
    url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${address.port}`,
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
    sendUnauthorized(response);
    return;
  }
  const rawPathname = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  const pathname = decodedPathname(rawPathname);
  const method = request.method ?? "";
  const qualification = qualifyOpenCodeV2Route(method, pathname);
  options.observedRequest?.(pathname);
  const reply = method === "POST" ? OPENCODE_V2_PERMISSION_REPLY_ROUTE.exec(pathname) : null;
  if (reply !== null) {
    if (options.onPermissionReply !== undefined) {
      // Broker posture: the reply is handed to the hub and never forwarded.
      await handlePermissionReply(request, response, options, reply[1]!, reply[2]!);
      return;
    }
    // Advisory posture: no broker authority yet; the client reply is the
    // answerer, so it passes through. The surface must not be labeled
    // enforced in this mode.
  } else if (method === "POST" && isReplyShapedPathname(pathname)) {
    // A reply-shaped path that does not map cleanly must never be forwarded
    // upstream under the hub credential (review P1-2: fail closed).
    sendJson(response, 400, { error: "unmappable permission reply path" });
    return;
  }
  if (options.enforced === true && qualification.disposition !== "forward") {
    // §2.2: an enforced gateway forwards only explicitly qualified read-only
    // and input routes. `deny`, `unknown`, and a broker route reached without
    // the broker hook (e.g. a non-POST verb on the reply path) all fail closed
    // and never reach the upstream under the hub credential.
    sendJson(response, 403, {
      error: `route class not qualified for direct access: ${qualification.routeClass}`,
    });
    return;
  }
  forward(request, response, upstream, upstreamAuth, options);
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
  // Review P3-1: `pathname` never contains the query string, so only the
  // suffix form is meaningful.
  return pathname.includes("/permission/") && pathname.endsWith("/reply");
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
  options: OpencodeServerGatewayOptions,
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
    const eventStream = isKeepaliveableEventStream(upstreamResponse.headers);
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    if (eventStream) {
      // A quiet stream must deliver its head now, not on the first event: a
      // buffered head leaves the client waiting on a body that may not arrive
      // for minutes, which is exactly the liveness gap the keepalive closes.
      response.flushHeaders();
    }
    upstreamResponse.pipe(response);
    // Armed after the pipe, so every forwarded upstream chunk resets the idle
    // timer: a busy stream is never interleaved with a keepalive frame.
    if (eventStream) {
      startSseKeepalive(upstreamResponse, response, sseKeepaliveMs(process.env), options.observedKeepalive);
    }
  });
  proxied.on("error", () => {
    if (!response.headersSent) sendJson(response, 502, { error: "gateway upstream unreachable" });
    else response.destroy();
  });
  request.pipe(proxied);
}

/**
 * True when the upstream response is an event stream the gateway may inject
 * plain comment frames into. A `content-encoding` other than identity is
 * excluded on purpose: the frame would be spliced into a compressed byte
 * stream and the client's decoder would fail — a broken stream is strictly
 * worse than an un-kept-alive one, so that case simply keeps the old
 * (drop-prone) behavior rather than corrupting anything.
 */
function isKeepaliveableEventStream(headers: IncomingMessage["headers"]): boolean {
  if (!(headers["content-type"] ?? "").toLowerCase().includes("text/event-stream")) return false;
  const encoding = (headers["content-encoding"] ?? "").toLowerCase();
  return encoding === "" || encoding === "identity";
}

/**
 * Writes one SSE comment frame per idle interval until the stream ends. The
 * timer is re-armed on every upstream chunk and cleared on close/end/finish on
 * either side, so a disconnected client never leaves a timer writing into a
 * dead response. `unref()` keeps it from holding the process open on its own.
 */
function startSseKeepalive(
  upstreamResponse: IncomingMessage,
  response: ServerResponse,
  intervalMs: number,
  observed: ((event: OpencodeSseKeepaliveEvent) => void) | undefined,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    observed?.("cleared");
  };
  const arm = (): void => {
    stop();
    timer = setTimeout(() => {
      timer = undefined;
      observed?.("fired");
      if (response.writableEnded || response.destroyed) return;
      response.write(SSE_KEEPALIVE_FRAME);
      arm();
    }, intervalMs);
    timer.unref();
    observed?.("armed");
  };
  arm();
  upstreamResponse.on("data", arm);
  upstreamResponse.once("end", stop);
  upstreamResponse.once("error", stop);
  upstreamResponse.once("close", stop);
  response.once("close", stop);
  response.once("finish", stop);
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

/**
 * The client-auth 401. A browser only shows its Basic-auth credential prompt
 * when the response carries `WWW-Authenticate`, so the gateway MUST send the
 * challenge or the web UI is unreachable from a browser (it renders the bare
 * JSON error instead). The realm string is byte-identical to stock
 * `opencode serve` (measured: `Basic realm="Secure Area"`) so the gateway stays
 * a faithful front door for the browser lane, not just preemptive API clients.
 */
function sendUnauthorized(response: ServerResponse): void {
  if (response.headersSent) return;
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": OPENCODE_BASIC_CHALLENGE,
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

/** The Basic-auth realm stock `opencode serve` advertises; pinned for fidelity. */
const OPENCODE_BASIC_CHALLENGE = 'Basic realm="Secure Area"';

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** Generates a per-gateway client password (published only via the discovery file). */
export function newTuiPassword(): string {
  return randomBytes(24).toString("hex");
}