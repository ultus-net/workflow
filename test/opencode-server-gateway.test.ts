import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import {
  createOpencodeServerGateway,
  newTuiPassword,
  DEFAULT_SSE_KEEPALIVE_MS,
  sseKeepaliveMs,
  type OpencodePermissionReply,
  type OpencodeSseKeepaliveEvent,
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
  /** Event streams held open by a client, destroyed on close (see below). */
  const held: ServerResponse[] = [];
  let busyTick = 0;
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
    if (pathname === "/api/event" || pathname === "/api/busy-event" || pathname === "/api/gzip-event") {
      // The v2 qualification route is an event stream (`/api/event`).
      // `/api/event` is SILENT after the head — the quiet case an ingress
      // proxy's idle timeout would drop. `/api/busy-event` emits steadily —
      // the busy case, which must never be interleaved with a keepalive.
      // `/api/gzip-event` is a compressed stream: a plaintext frame injected
      // into it would corrupt the client's decoder.
      const compressed = pathname === "/api/gzip-event";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        ...(compressed ? { "content-encoding": "gzip" } : {}),
      });
      response.flushHeaders();
      held.push(response);
      if (pathname === "/api/busy-event") {
        const ticker = setInterval(() => {
          busyTick += 1;
          response.write(`data: ${JSON.stringify({ tick: busyTick })}\n\n`);
        }, 10);
        response.once("close", () => clearInterval(ticker));
      }
      if (compressed) response.write(gzipSync(Buffer.from('data: {"compressed":true}\n\n')));
      return;
    }
    if (pathname === "/api/finite-event") {
      // A stream that ends on its own: a keepalive appended after the last
      // event would be bytes the client never expects.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write('data: {"done":true}\n\n');
      response.end();
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
    close: () => new Promise<void>((resolve, reject) => {
      // A held event stream would keep the server open past `close()`.
      for (const stream of held) stream.destroy();
      held.length = 0;
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/**
 * A raw byte-level view of a long-lived response. `fetch` would buffer and the
 * stream would have to be reimplemented, so the test speaks HTTP directly.
 * A stream that never delivers its head resolves as status 0 rather than
 * hanging the run — the gateway must open a quiet stream immediately.
 */
function openRawStream(target: string, headers: Record<string, string>): {
  readonly started: Promise<{
    readonly status: number;
    readonly contentType: string | undefined;
    readonly contentEncoding: string | undefined;
  }>;
  received(): string;
  close(): void;
} {
  const chunks: Buffer[] = [];
  let request: ClientRequest | undefined;
  const started = new Promise<{ status: number; contentType: string | undefined; contentEncoding: string | undefined }>((resolve) => {
    const head = setTimeout(() => resolve({ status: 0, contentType: undefined, contentEncoding: undefined }), 2_000);
    head.unref();
    request = httpRequest(target, { headers }, (response) => {
      clearTimeout(head);
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers["content-type"],
        contentEncoding: response.headers["content-encoding"],
      });
    });
    request.on("error", () => resolve({ status: 0, contentType: undefined, contentEncoding: undefined }));
    request.end();
  });
  return {
    started,
    received: () => Buffer.concat(chunks).toString("utf8"),
    close: () => { request?.destroy(); },
  };
}

function sseFrames(received: string): string[] {
  return received.split("\n\n").filter((frame) => frame !== "");
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

  // A browser only prompts for Basic auth when the 401 carries a challenge;
  // without it the web UI renders the bare JSON error. Pin the header and the
  // stock-opencode realm so a regression fails here, not in a browser.
  const denied = await fetch(gateway.url + "/health");
  assert.equal(denied.headers.get("www-authenticate"), 'Basic realm="Secure Area"');
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

/**
 * Event-stream keepalive: an ingress proxy with a ~4-minute idle timeout
 * closes a quiet `text/event-stream`, and the attached session dies with it.
 * The gateway therefore emits an SSE comment frame on an idle timer. This is
 * transport liveness only — it is not evidence of upstream health or of hub
 * authority, so it is ADVISORY until a live ingress probe records a verdict.
 */

test("gateway SSE keepalive: a silent event stream receives repeated comment frames and none are fabricated as data", async (t) => {
  const upstream = await stubUpstream();
  const previous = process.env.WORKFLOW_SSE_KEEPALIVE_MS;
  process.env.WORKFLOW_SSE_KEEPALIVE_MS = "100";
  const keepalive: OpencodeSseKeepaliveEvent[] = [];
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    observedKeepalive: (event) => { keepalive.push(event); },
  });
  const stream = openRawStream(`${gateway.url}/api/event`, { authorization: basic("opencode", "tuipw") });
  // One hook, in dependency order: the client socket must be released before
  // the gateway can finish closing, or a failing assertion deadlocks cleanup.
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_SSE_KEEPALIVE_MS;
    else process.env.WORKFLOW_SSE_KEEPALIVE_MS = previous;
    stream.close();
    await gateway.close();
    await upstream.close();
  });

  const started = await stream.started;
  assert.equal(started.status, 200, "a quiet event stream must deliver its head immediately");
  assert.match(started.contentType ?? "", /text\/event-stream/);
  // The head opens the stream; it must not wait on the first body byte, which
  // for a quiet stream is a whole keepalive interval away.
  assert.deepEqual(sseFrames(stream.received()), [], "the head must arrive before any frame");
  // The upstream says nothing, so every frame the client sees is the keepalive —
  // and it must repeat, not fire once: the proxy idle timeout recurs.
  await until(() => sseFrames(stream.received()).length >= 3);
  const frames = sseFrames(stream.received());
  assert.ok(frames.length >= 3, "a silent stream must keep receiving keepalive frames");
  for (const frame of frames) {
    assert.equal(frame, ": workflow-keepalive", "a comment frame carries no event or data field");
  }

  // Disconnect: the timer must not outlive the response it writes into. The
  // snapshot is synchronous, so any later fire is provably post-disconnect;
  // the close itself is delivered asynchronously, hence the settle window.
  const count = (event: OpencodeSseKeepaliveEvent): number => keepalive.filter((entry) => entry === event).length;
  stream.close();
  const firedAtDisconnect = count("fired");
  await new Promise((resolve) => setTimeout(resolve, 300)); // three intervals
  assert.equal(
    count("fired"),
    firedAtDisconnect,
    "the disconnect must clear the pending timer, not let it fire into a dead response",
  );
  assert.ok(firedAtDisconnect > 0, "the quiet stream must have been kept alive before the disconnect");
  assert.equal(count("armed"), count("fired") + count("cleared"), "every armed timer is fired or cleared, never left pending");
  const settled = keepalive.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(keepalive.length, settled, "no keepalive timer may outlive the disconnect");
});

test("gateway SSE keepalive: a busy event stream is never interleaved with a comment frame", async (t) => {
  const upstream = await stubUpstream();
  const previous = process.env.WORKFLOW_SSE_KEEPALIVE_MS;
  // Slower than the upstream's 10ms cadence: every chunk resets the idle timer,
  // so no frame may be injected into a stream that is not quiet.
  process.env.WORKFLOW_SSE_KEEPALIVE_MS = "120";
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
  });
  const stream = openRawStream(`${gateway.url}/api/busy-event`, { authorization: basic("opencode", "tuipw") });
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_SSE_KEEPALIVE_MS;
    else process.env.WORKFLOW_SSE_KEEPALIVE_MS = previous;
    stream.close();
    await gateway.close();
    await upstream.close();
  });

  assert.equal((await stream.started).status, 200);
  // The upstream emits every 10ms against a 120ms keepalive: watch for longer
  // than several intervals, or a timer that never resets would never be caught.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const frames = sseFrames(stream.received());
  assert.ok(frames.filter((frame) => frame.startsWith("data:")).length >= 3, "upstream data must pass through");
  assert.deepEqual(
    frames.filter((frame) => !frame.startsWith("data: ")),
    [],
    "a busy stream must not be interleaved with a keepalive comment",
  );
});

test("gateway SSE keepalive: a stream that ends on its own gets no appended frame", async (t) => {
  const upstream = await stubUpstream();
  const previous = process.env.WORKFLOW_SSE_KEEPALIVE_MS;
  process.env.WORKFLOW_SSE_KEEPALIVE_MS = "50";
  const keepalive: OpencodeSseKeepaliveEvent[] = [];
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    observedKeepalive: (event) => { keepalive.push(event); },
  });
  const stream = openRawStream(`${gateway.url}/api/finite-event`, { authorization: basic("opencode", "tuipw") });
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_SSE_KEEPALIVE_MS;
    else process.env.WORKFLOW_SSE_KEEPALIVE_MS = previous;
    stream.close();
    await gateway.close();
    await upstream.close();
  });

  assert.equal((await stream.started).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 250)); // five intervals
  assert.equal(stream.received(), 'data: {"done":true}\n\n', "a keepalive must not be appended past the end of a stream");
  assert.deepEqual(keepalive.filter((event) => event === "fired"), [], "an ended stream has nothing left to keep alive");
});

test("gateway SSE keepalive: a compressed event stream is left byte-identical (no frame injection)", async (t) => {
  const upstream = await stubUpstream();
  const previous = process.env.WORKFLOW_SSE_KEEPALIVE_MS;
  process.env.WORKFLOW_SSE_KEEPALIVE_MS = "50";
  const keepalive: OpencodeSseKeepaliveEvent[] = [];
  const gateway = await createOpencodeServerGateway({
    upstream: upstream.url,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    observedKeepalive: (event) => { keepalive.push(event); },
  });
  const stream = openRawStream(`${gateway.url}/api/gzip-event`, { authorization: basic("opencode", "tuipw") });
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFLOW_SSE_KEEPALIVE_MS;
    else process.env.WORKFLOW_SSE_KEEPALIVE_MS = previous;
    stream.close();
    await gateway.close();
    await upstream.close();
  });

  const started = await stream.started;
  assert.equal(started.status, 200);
  assert.equal(started.contentEncoding, "gzip", "the compressed head must be forwarded unchanged");
  await new Promise((resolve) => setTimeout(resolve, 250)); // five intervals
  // A plaintext frame spliced into a gzip member would break the client's
  // decoder, so a compressed stream is proxied untouched — the residual risk
  // is a proxy idle timeout, which is strictly better than a corrupt stream.
  assert.equal(stream.received().includes("workflow-keepalive"), false, "no plaintext frame may enter a compressed stream");
  assert.deepEqual(keepalive, [], "a compressed stream must not be given a keepalive timer at all");
});

test("gateway SSE keepalive: the interval defaults to 15s and only a positive integer overrides it", () => {
  assert.equal(DEFAULT_SSE_KEEPALIVE_MS, 15_000);
  assert.equal(sseKeepaliveMs({}), DEFAULT_SSE_KEEPALIVE_MS);
  assert.equal(sseKeepaliveMs({ WORKFLOW_SSE_KEEPALIVE_MS: "40" }), 40);
  for (const raw of ["", "0", "-1", "1.5", "abc"]) {
    assert.equal(
      sseKeepaliveMs({ WORKFLOW_SSE_KEEPALIVE_MS: raw }),
      DEFAULT_SSE_KEEPALIVE_MS,
      `${JSON.stringify(raw)} must fall back to the default, never a broken timer`,
    );
  }
});