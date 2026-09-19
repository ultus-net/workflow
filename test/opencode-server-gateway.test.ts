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
    if (pathname === "/gzip") {
      // Mirrors real `opencode serve`: gzipped JSON with content-encoding.
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(gzipSync(Buffer.from(JSON.stringify({ compressed: true }))));
      return;
    }
    if (pathname === "/reply" && request.method === "POST") {
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

  const response = await fetch(gateway.url + "/reply", {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json" },
    body: JSON.stringify({ reply: "once" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json() as unknown, { forwarded: true });
});

test("W071 gateway: newTuiPassword is distinct per call", () => {
  assert.notEqual(newTuiPassword(), newTuiPassword());
});