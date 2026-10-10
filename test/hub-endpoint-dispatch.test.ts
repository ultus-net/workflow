import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { createOpencodeServerGateway } from "../src/integrations/opencode-server-gateway.js";

/**
 * C1 hub endpoint (D5): the gateway Host-dispatch table.
 *
 * The load-bearing behavior: a Host in the `hubRoutes.hosts` set is proxied to
 * the hub UI loopback endpoint, the client `Host` is PRESERVED (the UI's
 * same-origin mutation guard compares `Origin` to `Host`), and the lane FAILS
 * CLOSED (503) when the endpoint cannot be resolved — it never falls through to
 * the OpenCode upstream on the hub's name. Every other Host is byte-identical
 * pass-through to OpenCode.
 *
 * Raw `http.request` (not `fetch`): the WHATWG fetch spec treats `Host` as a
 * forbidden header name and silently drops it, so a fetch-based test could never
 * exercise the dispatch at all.
 */

const AUTH = `Basic ${Buffer.from("opencode:0123456789abcdef").toString("base64")}`;

interface Stub {
  readonly url: string;
  readonly seen: { path: string; host: string | undefined; authorization: string | undefined }[];
  close(): Promise<void>;
}

async function stub(payload: unknown): Promise<Stub> {
  const seen: { path: string; host: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push({ path: request.url ?? "", host: request.headers.host, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface ProbeResult {
  readonly status: number;
  readonly body: unknown;
}

/** One raw request with an explicit `Host`; the ONLY faithful way to test dispatch. */
function probe(
  base: string,
  path: string,
  options: { host?: string; authorization?: string } = {},
): Promise<ProbeResult> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers.host = options.host;
    if (options.authorization !== undefined) headers.authorization = options.authorization;
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path, method: "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = text; }
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("a hub Host is proxied to the hub UI target and preserves the client Host", async () => {
  const opencode = await stub({ surface: "opencode" });
  const hubUi = await stub({ surface: "hub" });
  const gateway = await createOpencodeServerGateway({
    upstream: opencode.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "0123456789abcdef",
    host: "127.0.0.1",
    port: 0,
    hubRoutes: { hosts: ["hub.ultus.net"], target: () => hubUi.url },
  });
  try {
    const result = await probe(gateway.url, "/api/schedules", { host: "hub.ultus.net", authorization: AUTH });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { surface: "hub" });
    assert.equal(hubUi.seen.length, 1);
    assert.equal(hubUi.seen[0]!.host, "hub.ultus.net", "the client Host is preserved for the same-origin guard");
    assert.equal(hubUi.seen[0]!.authorization, undefined, "the hub lane carries no injected upstream credential");
    assert.equal(opencode.seen.length, 0, "the OpenCode upstream is never touched on the hub name");
  } finally {
    await gateway.close();
    await opencode.close();
    await hubUi.close();
  }
});

test("a hub Host with a port and mixed case still matches; the coding Host passes through", async () => {
  const opencode = await stub({ surface: "opencode" });
  const hubUi = await stub({ surface: "hub" });
  const gateway = await createOpencodeServerGateway({
    upstream: opencode.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "0123456789abcdef",
    host: "127.0.0.1",
    port: 0,
    hubRoutes: { hosts: ["hub.ultus.net"], target: () => hubUi.url },
  });
  try {
    const hub = await probe(gateway.url, "/x", { host: "HUB.ultus.net:443", authorization: AUTH });
    assert.equal(hub.status, 200);
    assert.deepEqual(hub.body, { surface: "hub" });
    // code.ultus.net and the default FQDN fall through to OpenCode.
    const code = await probe(gateway.url, "/api/info", { host: "code.ultus.net", authorization: AUTH });
    assert.equal(code.status, 200);
    assert.deepEqual(code.body, { surface: "opencode" });
    // No Host at all (a header-less probe) also routes to OpenCode.
    const bare = await probe(gateway.url, "/api/info", { authorization: AUTH });
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.body, { surface: "opencode" });
    assert.equal(opencode.seen.length, 2);
    assert.equal(hubUi.seen.length, 1);
  } finally {
    await gateway.close();
    await opencode.close();
    await hubUi.close();
  }
});

test("a hub Host fails closed (503) when the hub UI endpoint is unresolved — never an OpenCode fallthrough", async () => {
  const opencode = await stub({ surface: "opencode" });
  const gateway = await createOpencodeServerGateway({
    upstream: opencode.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "0123456789abcdef",
    host: "127.0.0.1",
    port: 0,
    hubRoutes: { hosts: ["hub.ultus.net"], target: () => undefined },
  });
  try {
    const result = await probe(gateway.url, "/", { host: "hub.ultus.net", authorization: AUTH });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "hub UI unavailable" });
    assert.equal(opencode.seen.length, 0, "the coding upstream must never answer on the hub name");
  } finally {
    await gateway.close();
    await opencode.close();
  }
});

test("the hub lane still requires the client credential (auth precedes dispatch)", async () => {
  const opencode = await stub({ surface: "opencode" });
  const hubUi = await stub({ surface: "hub" });
  const gateway = await createOpencodeServerGateway({
    upstream: opencode.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "0123456789abcdef",
    host: "127.0.0.1",
    port: 0,
    hubRoutes: { hosts: ["hub.ultus.net"], target: () => hubUi.url },
  });
  try {
    const result = await probe(gateway.url, "/", { host: "hub.ultus.net" });
    assert.equal(result.status, 401);
    assert.equal(hubUi.seen.length, 0, "an unauthenticated hub-lane request never reaches the hub UI");
  } finally {
    await gateway.close();
    await opencode.close();
    await hubUi.close();
  }
});

test("no hubRoutes means no dispatch table (byte-identical OpenCode-only pass-through)", async () => {
  const opencode = await stub({ surface: "opencode" });
  const gateway = await createOpencodeServerGateway({
    upstream: opencode.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "0123456789abcdef",
    host: "127.0.0.1",
    port: 0,
  });
  try {
    // Even a hub-looking Host passes through when no dispatch table is composed.
    const result = await probe(gateway.url, "/api/info", { host: "hub.ultus.net", authorization: AUTH });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { surface: "opencode" });
  } finally {
    await gateway.close();
    await opencode.close();
  }
});
