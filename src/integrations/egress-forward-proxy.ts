/**
 * W183: the parent-side forward proxy for the `network: "proxied"` containment
 * posture (NVIDIA adoption plan Wave B, B1).
 *
 * A contained process in a private network namespace reaches the host through
 * slirp4netns's `10.0.2.2` mapping. This proxy listens on the host loopback
 * and is the intended host-side endpoint for proxy-aware egress: every
 * proxy-aware request goes through it and is gated by W178's `decideEgress`
 * over the process's `EgressPolicy`.
 *
 * Honesty boundary (do not overclaim): this gates **proxy-passed** traffic
 * only, and it is the intended path, not the only one. A hostile process that
 * opens a raw socket is not fenced — slirp still carries it to the host,
 * host-loopback listeners included (this pass does not pass slirp
 * `--disable-host-loopback`). The proxy is the allow path, not a kernel fence;
 * `THREAT_MODEL.md` residual #1 records exactly this.
 *
 * Two request forms are handled:
 *
 * - **origin-form** (`GET /path` with a `Host` header, or an absolute-form
 *   target): the proxy re-issues the request to the origin over http/https.
 * - **CONNECT** (`CONNECT host:port`): the proxy opens a TCP tunnel after the
 *   same policy decision. This is how HTTPS reaches the origin without the
 *   proxy terminating TLS (no per-sandbox CA in this pass; P21).
 *
 * Deny-by-default is a property of the *proxy wiring*, not of `decideEgress`:
 * the W178 core reports `no_matching_rule` / `audit_only` as allowed-but-
 * reported (it never denies without an explicit `enforce` rule). The proxy is
 * the deny boundary, so it requires a **matched rule** (`reason:
 * "rule_matched"`) to forward and refuses everything else. That reading is
 * documented in `egress-policy.ts` ("Deny-by-default is the policy direction
 * the proxy wiring applies").
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";

import { decideEgress, type EgressPolicy } from "./egress-policy.js";

/** One observed proxy decision, for tests and the gated probe (advisory). */
export interface EgressProxyObservation {
  readonly form: "origin" | "connect";
  readonly host: string;
  readonly port?: number;
  readonly method: string;
  readonly path?: string;
  readonly allowed: boolean;
  readonly reason: string;
}

export interface EgressForwardProxy {
  /** `http://127.0.0.1:<port>` — what the sandbox's proxy env points at. */
  readonly url: string;
  readonly port: number;
  readonly observations: readonly EgressProxyObservation[];
  close(): Promise<void>;
}

export interface EgressForwardProxyOptions {
  readonly policy: EgressPolicy;
  /**
   * Optional sink for each decision (the W181 observation seam can consume
   * this). Failures are swallowed: observation is advisory and must never
   * break the proxy.
   */
  readonly onDecision?: (observation: EgressProxyObservation) => void;
  /** Test seam for the upstream connection; defaults to the node clients. */
  readonly fetchImpl?: typeof httpRequest;
}

/** A `host:port` target parsed from an absolute-form URL or a CONNECT line. */
interface ProxyTarget {
  readonly host: string;
  readonly port: number | undefined;
}

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

function splitHostPort(authority: string, defaultPort: number | undefined): ProxyTarget | undefined {
  const trimmed = authority.trim();
  if (trimmed.length === 0) return undefined;
  // IPv6 literal in brackets: [::1]:443
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close < 0) return undefined;
    const host = trimmed.slice(1, close).toLowerCase();
    const rest = trimmed.slice(close + 1);
    if (rest.length === 0) return { host, port: defaultPort };
    if (!rest.startsWith(":")) return undefined;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : undefined;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return { host: trimmed.toLowerCase(), port: defaultPort };
  const host = trimmed.slice(0, colon).toLowerCase();
  const port = Number(trimmed.slice(colon + 1));
  if (host.length === 0) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/**
 * Parses the request target. Returns the L4 target and the origin-form path;
 * `absolute` distinguishes `http://host/path` from `/path`.
 */
function parseTarget(request: IncomingMessage): { target: ProxyTarget; path: string; absolute: boolean } | undefined {
  const raw = request.url ?? "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    try {
      const url = new URL(raw);
      const port = url.port.length > 0 ? Number(url.port) : (url.protocol === "https:" ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT);
      return { target: { host: url.hostname.toLowerCase(), port }, path: `${url.pathname}${url.search}`, absolute: true };
    } catch {
      return undefined;
    }
  }
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return undefined;
  const target = splitHostPort(hostHeader, DEFAULT_HTTP_PORT);
  if (target === undefined) return undefined;
  return { target, path: raw.length === 0 ? "/" : raw, absolute: false };
}

function decisionAllows(policy: EgressPolicy, host: string, port: number | undefined, method: string, path: string | undefined): boolean {
  const decision = decideEgress(
    { host, ...(port === undefined ? {} : { port }), method, ...(path === undefined ? {} : { path }) },
    policy,
  );
  // Deny-by-default: only an explicit matched rule (enforce or audit) forwards.
  return decision.allowed && decision.reason === "rule_matched";
}

/**
 * Builds the policy-gated forward proxy. Each call binds an ephemeral loopback
 * port; the containment backend starts one per proxied run so no two runs
 * share an egress decision surface.
 */
export async function createEgressForwardProxy(options: EgressForwardProxyOptions): Promise<EgressForwardProxy> {
  const observations: EgressProxyObservation[] = [];
  const emit = (observation: EgressProxyObservation): void => {
    observations.push(observation);
    try {
      options.onDecision?.(observation);
    } catch {
      // Observation is advisory; never let a sink failure break egress.
    }
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleOriginForm(request, response, options.policy, emit, options.fetchImpl);
  });

  server.on("connect", (request: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const target = splitHostPort(request.url ?? "", DEFAULT_HTTPS_PORT);
    if (target === undefined) {
      emit({ form: "connect", host: "", method: "CONNECT", allowed: false, reason: "invalid_target" });
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const allowed = decisionAllows(options.policy, target.host, target.port, "CONNECT", undefined);
    emit({ form: "connect", host: target.host, ...(target.port === undefined ? {} : { port: target.port }), method: "CONNECT", allowed, reason: allowed ? "rule_matched" : "denied" });
    if (!allowed) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = netConnect({ host: target.host, port: target.port ?? DEFAULT_HTTPS_PORT }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const teardown = (): void => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", teardown);
    clientSocket.on("error", teardown);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("egress forward proxy could not bind a loopback port");
  }
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    observations,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

async function handleOriginForm(
  request: IncomingMessage,
  response: ServerResponse,
  policy: EgressPolicy,
  emit: (observation: EgressProxyObservation) => void,
  fetchImpl: typeof httpRequest | undefined,
): Promise<void> {
  const parsed = parseTarget(request);
  const method = request.method ?? "GET";
  if (parsed === undefined) {
    emit({ form: "origin", host: "", method, allowed: false, reason: "invalid_target" });
    response.writeHead(400).end("bad request target");
    return;
  }
  const { target, path, absolute } = parsed;
  const allowed = decisionAllows(policy, target.host, target.port, method, path);
  emit({ form: "origin", host: target.host, ...(target.port === undefined ? {} : { port: target.port }), method, path, allowed, reason: allowed ? "rule_matched" : "denied" });
  if (!allowed) {
    response.writeHead(403).end("egress denied by policy");
    return;
  }
  const secure = target.port === DEFAULT_HTTPS_PORT;
  const requester = fetchImpl ?? (secure ? httpsRequest : httpRequest);
  const upstream = requester(
    {
      host: target.host,
      port: target.port ?? (secure ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
      method,
      path: absolute ? path : request.url ?? path,
      headers: { ...request.headers, host: target.port === undefined ? target.host : `${target.host}:${target.port}` },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("egress upstream error");
  });
  request.pipe(upstream);
}
