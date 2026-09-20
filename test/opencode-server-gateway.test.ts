import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import {
  createOpencodeServerGateway,
  newTuiPassword,
  type OpencodePermissionReply,
} from "../src/integrations/opencode-server-gateway.js";

/**
 * W071 — the OpenCode server gateway contract.
 *
 * The load-bearing W071 decision (plan §3): the hub is the SOLE upstream
 * permission answerer, structurally — not by race. The stock TUI holds only a
 * gateway password; the upstream server password is hub-only. In broker mode
 * permission replies are handed to the hook (enforced posture, M2); in
 * advisory mode (no hook) they pass through. These run against a stub upstream
 * (no real opencode needed); the live server shape is covered by
 * `test/opencode-server-attach-probe.test.ts`.
 */

interface StubServer {
  readonly url: string;
  readonly requests: { readonly method: string; readonly path: string }[];
  close(): Promise<void>;
}

const UPSTREAM_CREDENTIAL = "up:secret";

async function stubUpstream(): Promise<StubServer> {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    const auth = (request.headers.authorization ?? "").match(/^Basic\s+(.+)$/);
    const creds = auth === null ? undefined : Buffer.from(auth[1]!, "base64").toString("utf8");
    if (creds !== UPSTREAM_CREDENTIAL) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://stub.invalid").pathname;
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "stub" }));
      return;
    }
    if (pathname === "/config") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ permission: { edit: "ask", bash: "ask", task: "ask" } }));
      return;
    }
    if (pathname === "/api/integration") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ integration: [] }));
      return;
    }
    if (pathname === "/api/session/s/compact" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { compacted: true } }));
      return;
    }
    if (pathname === "/gzip") {
      // Mirrors real `opencode serve`: gzipped JSON with content-encoding.
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(gzipSync(Buffer.from(JSON.stringify({ compressed: true }))));
      return;
    }
    if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(pathname) && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ forwarded: true }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("W071 gateway: unauthenticated and wrong-password clients are rejected", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    onPermissionReply: () => undefined,
  });
  t.after(() => void gateway.close());

  assert.equal((await fetch(gateway.url + "/health")).status, 401);
  assert.equal((await fetch(gateway.url + "/health", { headers: { authorization: basic("opencode", "nope") } })).status, 401);
});

test("W071 gateway: the TUI password reaches the upstream, and gzipped JSON survives", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    onPermissionReply: () => undefined,
  });
  t.after(() => void gateway.close());
  const headers = { authorization: basic("opencode", "tuipw") };

  const config = await fetch(gateway.url + "/config", { headers });
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json() as unknown, { permission: { edit: "ask", bash: "ask", task: "ask" } });

  // The M0 finding: dropping content-encoding broke the client with gzipped bodies.
  const gz = await fetch(gateway.url + "/gzip", { headers });
  assert.equal(gz.status, 200);
  assert.deepEqual(await gz.json() as unknown, { compressed: true });
});

test("W071 gateway: a TUI-only credential cannot reach the upstream reply route directly", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const response = await fetch(upstream.url + "/api/session/s/permission/r/reply", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(response.status, 401);
});

test("W071 gateway (broker mode): replies are intercepted and handed to the broker, never forwarded", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const seen: OpencodePermissionReply[] = [];
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    onPermissionReply: (reply) => { seen.push(reply); },
  });
  t.after(() => void gateway.close());

  const response = await fetch(gateway.url + "/api/session/sess1/permission/req1/reply?directory=/tmp", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [{ sessionId: "sess1", requestId: "req1", reply: "reject" }]);
  assert.equal(upstream.requests.some((entry) => entry.path.startsWith("/api/session")), false);
});

test("W071 gateway (broker mode): a broker failure fails closed (no forward, 502)", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    onPermissionReply: () => { throw new Error("policy engine unavailable"); },
  });
  t.after(() => void gateway.close());

  const response = await fetch(gateway.url + "/api/session/sess1/permission/req1/reply", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(response.status, 502);
  assert.equal(upstream.requests.some((entry) => entry.path.startsWith("/api/session")), false);
});

test("W071 gateway (advisory mode): without a broker hook, replies pass through upstream", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
  });
  t.after(() => void gateway.close());

  // Must be the REAL reply route (review P1-1: the old test hit /reply, which
  // only exercised generic forwarding and would pass with interception broken).
  const response = await fetch(gateway.url + "/api/session/sess1/permission/req1/reply?directory=/tmp", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json" },
    body: JSON.stringify({ reply: "once" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json() as unknown, { forwarded: true });
  assert.equal(upstream.requests.some((entry) => entry.path.startsWith("/api/session")), true);
});

test("W071 gateway: percent-encoded reply routes cannot dodge interception (review P1-2)", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const seen: OpencodePermissionReply[] = [];
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    onPermissionReply: (reply) => { seen.push(reply); },
  });
  t.after(() => void gateway.close());
  const headers = { authorization: basic("opencode", "tuipw"), "content-type": "application/json" };

  const encoded = await fetch(gateway.url + "/api/session/sess1/permission/req1/%72eply", {
    method: "POST", headers, body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(encoded.status, 200);
  assert.deepEqual(seen, [{ sessionId: "sess1", requestId: "req1", reply: "reject" }]);
  assert.equal(upstream.requests.some((entry) => entry.path.startsWith("/api/session")), false);

  // A reply-shaped path that does not map cleanly must fail closed, never
  // reach the upstream under the hub credential.
  const unmappable = await fetch(gateway.url + "/api/session/sess1/permission/req1/%2E%2E/reply", {
    method: "POST", headers, body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(unmappable.status, 400);
  assert.equal(seen.length, 1);
  assert.equal(upstream.requests.some((entry) => entry.path.startsWith("/api/session")), false);
});

test("W071 gateway: newTuiPassword is distinct per call", () => {
  assert.notEqual(newTuiPassword(), newTuiPassword());
});

test("W071 gateway (enforced): construction fails closed without the broker hook", async () => {
  const upstream = await stubUpstream();
  try {
    await assert.rejects(
      createOpencodeServerGateway({
        upstream: upstream.url,
        upstreamUsername: "up",
        upstreamPassword: "secret",
        tuiPassword: "tuipw",
        enforced: true,
      }),
      /enforced gateway requires the broker hook/,
    );
  } finally {
    void upstream.close();
  }
});

/**
 * Route-class qualification through the gateway (spec §2.2): an enforced
 * gateway is the authority boundary, so a v2 client must not be able to call
 * mutation/authority routes directly, while read-only observation and the
 * brokered permission reply stay reachable.
 */

test("W071 gateway (enforced): read-only observation is forwarded", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    enforced: true,
    onPermissionReply: () => undefined,
  });
  t.after(() => void gateway.close());

  const response = await fetch(gateway.url + "/api/integration", {
    headers: { authorization: basic("opencode", "tuipw") },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json() as unknown, { integration: [] });
});

test("W080 gateway (enforced): compact is a forwarded session-input op (operator-controlled maintenance)", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    enforced: true,
    onPermissionReply: () => undefined,
  });
  t.after(() => void gateway.close());

  const response = await fetch(gateway.url + "/api/session/s/compact", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200, "compact must forward to the upstream in enforced posture");
});

test("W071 gateway (enforced): mutation route classes are denied and never forwarded", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    enforced: true,
    onPermissionReply: () => undefined,
  });
  t.after(() => void gateway.close());
  const headers = { authorization: basic("opencode", "tuipw"), "content-type": "application/json" };

  const denied = [
    ["POST", "/api/experimental/fs/write"],
    ["POST", "/api/session/s/shell"],
    ["POST", "/api/mcp"],
    ["POST", "/api/pty"],
    ["POST", "/api/session/s/purge"],
    ["DELETE", "/api/session/s"],
    ["DELETE", "/api/session/s/message"],
    ["PUT", "/api/session/s/message"],
    ["PUT", "/api/session/import"],
    ["PATCH", "/api/session/import"],
    ["DELETE", "/api/session/import"],
    ["POST", "/api/experimental/unknown"],
    // A read, but denied: the config payload carries provider credentials the
    // gateway must not hand a client (review P3).
    ["GET", "/api/config"],
  ] as const;
  for (const [method, path] of denied) {
    const init: RequestInit = { method, headers };
    if (method === "POST" || method === "PUT" || method === "PATCH") init.body = "{}";
    const response = await fetch(gateway.url + path, init);
    assert.equal(response.status, 403, `${method} ${path} must be denied in enforced posture`);
  }
  assert.equal(
    upstream.requests.some((entry) => entry.path.startsWith("/api/")),
    false,
    "denied route classes must never reach the upstream under the hub credential",
  );
});

test("W071 gateway (enforced): a non-POST verb on the broker reply route is denied, never forwarded", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    enforced: true,
    onPermissionReply: () => undefined,
  });
  t.after(() => void gateway.close());
  const headers = { authorization: basic("opencode", "tuipw") };

  // The reply route must be broker-only for every verb: a broker disposition
  // reached without the broker hook fails closed rather than handing the hub
  // credential to a client-supplied call on the authority route.
  for (const method of ["GET", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(gateway.url + "/api/session/s/permission/r/reply", { method, headers });
    assert.equal(response.status, 403, `${method} on the reply route must be denied in enforced posture`);
  }
  assert.equal(
    upstream.requests.some((entry) => entry.path.startsWith("/api/")),
    false,
    "a non-POST reply route must never reach the upstream under the hub credential",
  );
});

test("W071 gateway (enforced): qualified read-only routes are forwarded, not blocked", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    enforced: true,
    onPermissionReply: () => undefined,
  });
  t.after(() => void gateway.close());
  const headers = { authorization: basic("opencode", "tuipw") };

  const reads = ["/api/experimental/fs/read", "/api/integration", "/api/command", "/api/session"];
  for (const path of reads) {
    const response = await fetch(gateway.url + path, { headers });
    assert.notEqual(response.status, 403, `qualified read ${path} must not be denied`);
    assert.equal(upstream.requests.some((entry) => entry.path === path), true, `${path} must reach the upstream`);
  }
});

test("W071 gateway (enforced): the brokered reply route is intercepted, not denied", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const seen: OpencodePermissionReply[] = [];
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    enforced: true,
    onPermissionReply: (reply) => { seen.push(reply); },
  });
  t.after(() => void gateway.close());

  const response = await fetch(gateway.url + "/api/session/sess1/permission/req1/reply", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json" },
    body: JSON.stringify({ reply: "once" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [{ sessionId: "sess1", requestId: "req1", reply: "once" }]);
  assert.equal(upstream.requests.some((entry) => entry.path.startsWith("/api/")), false);
});

test("W071 gateway (advisory): unqualified mutations still pass through, no enforced claim", async (t) => {
  const upstream = await stubUpstream();
  t.after(() => void upstream.close());
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
  });
  t.after(() => void gateway.close());

  // Advisory posture preserves the historical pass-through: the surface is not
  // labeled enforced, so the route-class denial does not apply.
  const response = await fetch(gateway.url + "/api/experimental/unknown", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw") },
  });
  assert.equal(response.status, 404);
  assert.equal(upstream.requests.some((entry) => entry.path === "/api/experimental/unknown"), true);
});