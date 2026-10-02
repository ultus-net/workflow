import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createConnection } from "node:net";
import { test } from "node:test";

import { createEgressForwardProxy } from "../src/integrations/egress-forward-proxy.js";
import type { EgressPolicy } from "../src/integrations/egress-policy.js";

/**
 * W183: focused unit coverage of the policy-gated forward proxy. The live
 * mediation proof (a contained agent actually traversing the proxy) is the
 * gated probe; these tests pin the decision wiring the probe depends on.
 *
 * Node's `fetch` refuses to set the `Host` header, which is exactly the L4
 * input an origin-form proxy request carries, so these tests speak HTTP with
 * `node:http` and a custom `Host` header (the proxy address is the TCP peer,
 * the `Host` header names the logical destination).
 */

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test upstream failed to bind");
  return { server, port: address.port };
}

interface OriginResult {
  readonly status: number;
  readonly body: string;
}

/** Sends an origin-form request to the proxy for the logical destination `host`. */
function originRequest(proxyPort: number, host: string, path: string, method = "GET", body?: string): Promise<OriginResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: proxyPort, path, method, headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** Opens a raw connection and returns the accumulated response text. */
function rawRequest(proxyPort: number, payload: string, until: (text: string) => boolean = (text) => text.includes("\r\n\r\n")): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: proxyPort });
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (until(Buffer.concat(chunks).toString("utf8"))) { socket.end(); resolve(Buffer.concat(chunks).toString("utf8")); }
    });
    socket.on("error", reject);
    setTimeout(() => { socket.end(); resolve(Buffer.concat(chunks).toString("utf8")); }, 2000);
  });
}

// The proxy re-issues to the logical destination, so the unit test uses a
// reachable loopback host as the allowed destination.
const ALLOW_HOST = "127.0.0.1";

test("W183 proxy forwards an origin-form request only when a rule matches", async () => {
  const upstream = await listen((_req, res) => { res.writeHead(200); res.end("UPSTREAM"); });
  const policy: EgressPolicy = { rules: [{ id: "allow", host: ALLOW_HOST, port: upstream.port, mode: "enforce" }] };
  const proxy = await createEgressForwardProxy({ policy });
  try {
    const allowed = await originRequest(proxy.port, `${ALLOW_HOST}:${upstream.port}`, "/x", "POST", "hello");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "UPSTREAM");
    assert.equal(proxy.observations[0]?.allowed, true);
    assert.equal(proxy.observations[0]?.reason, "rule_matched");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("W183 proxy denies an unlisted host (deny-by-default, not the W178 audit default)", async () => {
  // No rules at all: decideEgress reports `no_matching_rule` as allowed-but-
  // reported; the proxy is the deny boundary and must refuse.
  const proxy = await createEgressForwardProxy({ policy: { rules: [] } });
  try {
    const response = await originRequest(proxy.port, `${ALLOW_HOST}:80`, "/x", "POST", "x");
    assert.equal(response.status, 403);
    assert.equal(proxy.observations.length, 1);
    assert.equal(proxy.observations[0]?.allowed, false);
    assert.equal(proxy.observations[0]?.reason, "denied");
  } finally {
    await proxy.close();
  }
});

test("W183 proxy denies a request outside a rule's L7 path scope", async () => {
  const upstream = await listen((_req, res) => { res.writeHead(200); res.end("UPSTREAM"); });
  const policy: EgressPolicy = { rules: [{ id: "allow", host: ALLOW_HOST, port: upstream.port, paths: ["/v1"], mode: "enforce" }] };
  const proxy = await createEgressForwardProxy({ policy });
  try {
    const inside = await originRequest(proxy.port, `${ALLOW_HOST}:${upstream.port}`, "/v1/chat", "POST", "x");
    assert.equal(inside.status, 200);
    const outside = await originRequest(proxy.port, `${ALLOW_HOST}:${upstream.port}`, "/admin", "POST", "x");
    assert.equal(outside.status, 403);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("W183 proxy parses an absolute-form request target as L4+L7", async () => {
  const upstream = await listen((_req, res) => { res.writeHead(200); res.end("UPSTREAM"); });
  const policy: EgressPolicy = { rules: [{ id: "allow", host: ALLOW_HOST, port: upstream.port, mode: "enforce" }] };
  const proxy = await createEgressForwardProxy({ policy });
  try {
    const text = await rawRequest(
      proxy.port,
      `POST http://${ALLOW_HOST}:${upstream.port}/v1 HTTP/1.1\r\nHost: ${ALLOW_HOST}:${upstream.port}\r\nContent-Length: 1\r\n\r\nx`,
      (value) => value.includes("UPSTREAM"),
    );
    assert.match(text, /200 OK/);
    assert.match(text, /UPSTREAM/);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("W183 proxy denies a CONNECT to an unlisted host and allows a listed one", async () => {
  const upstream = await listen((_req, res) => { res.writeHead(200); res.end("TUNNEL"); });
  const policy: EgressPolicy = { rules: [{ id: "allow", host: ALLOW_HOST, port: upstream.port, mode: "enforce" }] };
  const proxy = await createEgressForwardProxy({ policy });
  try {
    const denied = await rawRequest(proxy.port, "CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n", (text) => text.includes("403"));
    assert.match(denied, /403 Forbidden/);

    const tunnel = await rawRequest(
      proxy.port,
      `CONNECT ${ALLOW_HOST}:${upstream.port} HTTP/1.1\r\nHost: ${ALLOW_HOST}:${upstream.port}\r\n\r\nGET / HTTP/1.1\r\nHost: ${ALLOW_HOST}:${upstream.port}\r\n\r\n`,
      (text) => text.includes("TUNNEL"),
    );
    assert.match(tunnel, /200 Connection Established/);
    assert.match(tunnel, /TUNNEL/);
    assert.equal(proxy.observations.some((observation) => observation.form === "connect" && observation.allowed), true);
    assert.equal(proxy.observations.some((observation) => observation.form === "connect" && !observation.allowed), true);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("W183 proxy rejects a CONNECT with a malformed authority and emits an invalid_target observation", async () => {
  const proxy = await createEgressForwardProxy({ policy: { rules: [{ id: "a", host: ALLOW_HOST, mode: "enforce" }] } });
  try {
    const text = await rawRequest(proxy.port, "CONNECT :443 HTTP/1.1\r\nHost: :443\r\n\r\n", (value) => value.includes("400"));
    assert.match(text, /400/);
    assert.equal(proxy.observations[0]?.reason, "invalid_target");
  } finally {
    await proxy.close();
  }
});

test("W183 proxy issues the upstream request through the injected fetchImpl seam", async () => {
  const upstream = await listen((_req, res) => { res.writeHead(200); res.end("VIA-SEAM"); });
  const policy: EgressPolicy = { rules: [{ id: "allow", host: ALLOW_HOST, port: upstream.port, mode: "enforce" }] };
  let calls = 0;
  const seam = ((...args: unknown[]) => {
    calls += 1;
    return (httpRequest as unknown as (...a: unknown[]) => import("node:http").ClientRequest)(...args);
  }) as unknown as typeof httpRequest;
  const proxy = await createEgressForwardProxy({ policy, fetchImpl: seam });
  try {
    const allowed = await originRequest(proxy.port, `${ALLOW_HOST}:${upstream.port}`, "/x", "GET");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "VIA-SEAM");
    assert.equal(calls, 1, "the proxy must issue the upstream request through the injected fetchImpl");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});
