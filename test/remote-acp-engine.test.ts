import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EVENT_RECONNECT_ATTEMPTS,
  DEFAULT_EVENT_RECONNECT_BACKOFF_MS,
  EVENT_RECONNECT_MAX_BACKOFF_MS,
  HttpRemoteEngine,
  eventReconnectBackoffMs,
  isPermissionAsked,
  normalizeEventEnvelope,
  permissionToolCallId,
  sseData,
  type RemoteEngineEvent,
  type RemoteEnginePermissionRequest,
} from "../src/integrations/remote-acp/engine.js";

const encoder = new TextEncoder();

async function* bytes(parts: readonly string[]): AsyncGenerator<Uint8Array> {
  const e = new TextEncoder();
  for (const part of parts) yield e.encode(part);
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

async function collectEvents(stream: AsyncIterable<RemoteEngineEvent>): Promise<RemoteEngineEvent[]> {
  const out: RemoteEngineEvent[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

/** A `text/event-stream` body that delivers `text` and then ends when `close`. */
function sse(text: string, close: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(encoder.encode(text));
      if (close) controller.close();
    },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const status = (sessionID: string): string =>
  `data: {"payload":{"type":"session.status","properties":{"sessionID":"${sessionID}","status":{"type":"idle"}}}}\n\n`;

test("sseData extracts data payloads and joins multi-line data", async () => {
  const signal = new AbortController().signal;
  const data = await collect(sseData(bytes(['data: {"a":1}\n\n', "data: line1\ndata: line2\n\n"]), signal));
  assert.deepEqual(data, ['{"a":1}', "line1\nline2"]);
});

test("sseData handles payloads split across chunk boundaries", async () => {
  const signal = new AbortController().signal;
  const data = await collect(sseData(bytes(['data: {"a"', ':1}\n\n', "data: x\n", "\n"]), signal));
  assert.deepEqual(data, ['{"a":1}', "x"]);
});

test("HttpRemoteEngine sends the directory query and basic auth on requests", async () => {
  const captured: { url: string; init: RequestInit | undefined }[] = [];
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096/",
    cwd: "/workspace",
    username: "operator",
    password: "secret",
    fetch: async (url, init) => {
      captured.push({ url: String(url), init });
      return new Response(JSON.stringify({ healthy: true, version: "1.18.31" }), { status: 200 });
    },
  });
  const health = await engine.health();
  assert.deepEqual(health, { healthy: true, version: "1.18.31" });
  // The v2 info route is the primary health contract (v1 fallback below).
  assert.match(captured[0]!.url, /^http:\/\/127\.0\.0\.1:4096\/api\/info\?directory=%2Fworkspace$/);
  const headers = captured[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from("operator:secret").toString("base64")}`);
});

test("HttpRemoteEngine health falls back to the v1 route when /api/info is missing", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4097",
    cwd: "/workspace",
    username: "operator",
    password: "secret",
    fetch: async (url) => String(url).includes("/api/info")
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify({ healthy: true, version: "1.18.31" }), { status: 200 }),
  });
  assert.deepEqual(await engine.health(), { healthy: true, version: "1.18.31" });
});

test("HttpRemoteEngine health rejects on an auth failure instead of degrading to unhealthy", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4098",
    cwd: "/workspace",
    username: "operator",
    password: "wrong",
    fetch: async () => new Response("unauthorized", { status: 401 }),
  });
  await assert.rejects(() => engine.health(), /failed \(401\)/);
});

test("HttpRemoteEngine health refuses the v2 HTML catch-all served on /global/health", async () => {
  // Stock v2.x serves the web UI as an SPA fallback on bare paths: a 200 whose
  // body is HTML must never parse as healthy.
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4099",
    cwd: "/workspace",
    fetch: async (url) => String(url).includes("/api/info")
      ? new Response("not found", { status: 404 })
      : new Response("<!doctype html><html lang=\"en\"><body>OpenCode</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.deepEqual(await engine.health(), { healthy: false });
});

test("HttpRemoteEngine posts the prompt and the permission reply to the documented routes", async () => {
  const captured: { url: string; body: unknown }[] = [];
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    fetch: async (url, init) => {
      captured.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    },
  });
  await engine.prompt({ sessionId: "ses_1", cwd: "/w", text: "hello" });
  await engine.replyPermission({ sessionId: "ses_1", requestId: "per_1", reply: "reject", cwd: "/w" });
  assert.match(captured[0]!.url, /\/session\/ses_1\/message\?directory=%2Fw$/);
  assert.deepEqual(captured[0]!.body, { parts: [{ type: "text", text: "hello" }] });
  assert.match(captured[1]!.url, /\/api\/session\/ses_1\/permission\/per_1\/reply\?directory=%2Fw$/);
  assert.deepEqual(captured[1]!.body, { reply: "reject" });
});

test("HttpRemoteEngine events stream parses SSE event envelopes", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    // One-shot: this test is about envelope parsing, and a stream that ends is
    // reconnectable, not final (the resume cases below own that).
    eventReconnect: { maxAttempts: 0 },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"payload":{"type":"session.status","properties":{"sessionID":"s","status":{"type":"idle"}}}}\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const events: RemoteEngineEvent[] = [];
  for await (const event of engine.events({ cwd: "/w", signal: new AbortController().signal })) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "session.status");
});

test("normalizeEventEnvelope reads the v2 `data` envelope (live 2.0.10)", () => {
  // The live plane wraps the payload under `data`, never `properties`. This is
  // the shape that made every permission request unmappable (sessionID/id
  // undefined) and hung every mutating tool on the C1 plane. Pinned verbatim
  // from a captured `/api/event` frame.
  const event = normalizeEventEnvelope({
    id: "evt_x",
    created: 1,
    type: "permission.asked",
    location: { directory: "/workspace" },
    data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["echo hi"], source: { type: "tool", id: "call_1" } },
  });
  assert.equal(event?.type, "permission.asked");
  assert.equal((event?.properties as RemoteEnginePermissionRequest).sessionID, "ses_1");
  assert.equal((event?.properties as RemoteEnginePermissionRequest).id, "per_1");
});

test("normalizeEventEnvelope still reads the v1 contract and payload-wrapper shapes", () => {
  const contract = normalizeEventEnvelope({ type: "session.status", properties: { sessionID: "s" } });
  assert.deepEqual(contract, { type: "session.status", properties: { sessionID: "s" } });
  const wrapped = normalizeEventEnvelope({ payload: { type: "session.status", properties: { sessionID: "s" } } });
  assert.deepEqual(wrapped, { type: "session.status", properties: { sessionID: "s" } });
  // A frame with no string type is not an event; the caller fails closed.
  assert.equal(normalizeEventEnvelope({ data: { sessionID: "s" } }), undefined);
  assert.equal(normalizeEventEnvelope("nope"), undefined);
});

test("isPermissionAsked accepts both v2 wire spellings", () => {
  assert.equal(isPermissionAsked({ type: "permission.asked", properties: {} }), true);
  assert.equal(isPermissionAsked({ type: "permission.v2.asked", properties: {} }), true);
  assert.equal(isPermissionAsked({ type: "session.status", properties: {} }), false);
});

test("permissionToolCallId reads the v2 source.id and the v1 tool.callID", () => {
  // v2 (live): the tool-call id rides `source.id`, matching `session.tool.*` `data.id`.
  assert.equal(
    permissionToolCallId({ id: "per_1", sessionID: "s", action: "edit", resources: [], source: { type: "tool", id: "call_1" } } as unknown as RemoteEnginePermissionRequest),
    "call_1",
  );
  // v1/ACP: the contract `tool.callID` wins when present.
  assert.equal(
    permissionToolCallId({ id: "per_1", sessionID: "s", action: "edit", resources: [], tool: { callID: "call_2" } }),
    "call_2",
  );
  // Neither present: no call id (the broker falls back to session+tool).
  assert.equal(permissionToolCallId({ id: "per_1", sessionID: "s", action: "edit", resources: [] }), undefined);
});

/**
 * The reconnect cases below stand in for the ingress proxy that destroys a
 * quiet `/api/event` response (~4-minute idle timeout). The drop is what the
 * gateway keepalive cannot always prevent, and a one-shot subscription turned
 * it into a silently dead session; these pin the bounded re-open.
 */

test("HttpRemoteEngine events re-opens the route after a dropped stream", async () => {
  const paths: string[] = [];
  const delivered = deferred();
  let opens = 0;
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: 3, backoffMs: 1 },
    fetch: async (url, init) => {
      opens += 1;
      paths.push(new URL(String(url)).pathname);
      if (opens === 1) {
        // The first stream delivers one event and then dies mid-session.
        return new Response(sse(status("before"), true), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      // The second subscription stays open: the session must survive, not
      // merely re-subscribe. Only the caller's abort tears it down.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(status("after")));
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const controller = new AbortController();
  const events: RemoteEngineEvent[] = [];
  const pump = (async () => {
    for await (const event of engine.events({ cwd: "/w", signal: controller.signal })) {
      events.push(event);
      if (events.length === 2) delivered.resolve();
    }
  })();
  await delivered.promise;
  controller.abort();
  await pump;
  assert.deepEqual(
    events.map((event) => (event.properties as { sessionID: string }).sessionID),
    ["before", "after"],
    "the event delivered before the drop and the one after the reconnect must both reach the caller",
  );
  assert.deepEqual(paths, ["/api/event", "/api/event"]);
});

test("HttpRemoteEngine events re-evaluate the v1 route fallback on a reconnect", async () => {
  const paths: string[] = [];
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: 1, backoffMs: 1 },
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      // A reconnect must re-decide the route, never inherit the first choice:
      // v2 answers the HTML catch-all and v1 still serves the stream.
      return path === "/api/event"
        ? new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })
        : new Response(sse(status("v1"), true), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const events: RemoteEngineEvent[] = [];
  for await (const event of engine.events({ cwd: "/w", signal: new AbortController().signal })) events.push(event);
  assert.deepEqual(paths, ["/api/event", "/global/event", "/api/event", "/global/event"]);
  assert.equal(events.length, 2, "both the dropped stream and its v1 reconnect delivered their event");
});

test("HttpRemoteEngine events stop at the attempt cap instead of reconnecting forever", async () => {
  let opens = 0;
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: 2, backoffMs: 1 },
    fetch: async () => {
      opens += 1;
      // A server that keeps hanging up: the bound must end the subscription.
      return new Response(sse("", true), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const events: RemoteEngineEvent[] = [];
  for await (const event of engine.events({ cwd: "/w", signal: new AbortController().signal })) events.push(event);
  assert.equal(opens, 3, "the initial subscription plus exactly maxAttempts reconnects, then the generator ends");
  assert.equal(events.length, 0);
});

test("HttpRemoteEngine events surface a dropped stream once the cap is spent", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: 0, backoffMs: 1 },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error("socket hang up")); },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  // A fault is never swallowed into a silent end: the caller's stream-error
  // path (the authority records it) has to see it.
  await assert.rejects(
    () => collectEvents(engine.events({ cwd: "/w", signal: new AbortController().signal })),
    /socket hang up/,
  );
});

test("HttpRemoteEngine events never re-open the route for an aborted subscription", async () => {
  const controller = new AbortController();
  let opens = 0;
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: 5, backoffMs: 20 },
    fetch: async () => {
      opens += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller_) {
            controller_.close();
            // The caller aborts while the reconnect backoff is sleeping — the
            // 0ms timer is armed before the 20ms one, so the abort lands there.
            setTimeout(() => controller.abort(), 0);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const events: RemoteEngineEvent[] = [];
  for await (const event of engine.events({ cwd: "/w", signal: controller.signal })) events.push(event);
  assert.equal(opens, 1, "an abort during the backoff must end the subscription, not re-open it");
  assert.equal(events.length, 0);
  assert.equal(controller.signal.aborted, true);
});

test("eventReconnect bounds ignore nonsense values and back off by doubling", async () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => eventReconnectBackoffMs(attempt, DEFAULT_EVENT_RECONNECT_BACKOFF_MS)),
    [250, 500, 1000, 2000, 4000, EVENT_RECONNECT_MAX_BACKOFF_MS, EVENT_RECONNECT_MAX_BACKOFF_MS],
  );
  const dropper = async (): Promise<Response> =>
    new Response(sse("", true), { status: 200, headers: { "content-type": "text/event-stream" } });
  // A negative attempt bound falls back to the default — proven with a 1ms
  // backoff so the assertion costs milliseconds, not the default 33s schedule.
  let opens = 0;
  const defaulted = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: -1, backoffMs: 1 },
    fetch: async () => {
      opens += 1;
      return dropper();
    },
  });
  await collectEvents(defaulted.events({ cwd: "/w", signal: new AbortController().signal }));
  assert.equal(opens, DEFAULT_EVENT_RECONNECT_ATTEMPTS + 1);

  // A non-integer backoff is not a sub-millisecond backoff: it is ignored, so
  // the reconnect waits the real default before re-opening the route.
  const started = Date.now();
  let paced = 0;
  const pacedEngine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: 1, backoffMs: 1.5 },
    fetch: async () => {
      paced += 1;
      return dropper();
    },
  });
  await collectEvents(pacedEngine.events({ cwd: "/w", signal: new AbortController().signal }));
  assert.equal(paced, 2);
  assert.ok(
    Date.now() - started >= 200,
    "a non-integer backoff must fall back to the 250ms default, never to 1.5ms",
  );
});

test("HttpRemoteEngine events throws when the route cannot be opened at all", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    eventReconnect: { maxAttempts: 3, backoffMs: 1 },
    fetch: async () => new Response("unauthorized", { status: 401 }),
  });
  // A failed open is not a dropped stream: it surfaces, so a wrong credential
  // is never retried into silence.
  await assert.rejects(
    () => collectEvents(engine.events({ cwd: "/w", signal: new AbortController().signal })),
    /event stream failed \(401\)/,
  );
});

test("HttpRemoteEngine fails loudly on a non-OK response", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    fetch: async () => new Response("nope", { status: 401 }),
  });
  await assert.rejects(() => engine.createSession({ cwd: "/w" }), /failed \(401\)/);
});

test("HttpRemoteEngine parses sessions, messages, agents, and providers", async () => {
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/session") return json([{ id: "ses_1", title: "T", time: { updated: 5 } }]);
      if (path === "/session/ses_1") return json({ id: "ses_1", title: "T" });
      if (path === "/session/ses_1/message") return json([{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "hi" }] }]);
      if (path === "/agent") return json([{ id: "build", mode: "primary" }]);
      if (path === "/config/providers") return json({ providers: [{ id: "anthropic", name: "Anthropic", models: { claude: { id: "claude", name: "Claude" } } }] });
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(await engine.listSessions({ cwd: "/w" }), [{ id: "ses_1", title: "T", time: { updated: 5 } }]);
  assert.deepEqual(await engine.getSession({ sessionId: "ses_1", cwd: "/w" }), { id: "ses_1", title: "T" });
  assert.deepEqual(await engine.messages({ sessionId: "ses_1", cwd: "/w" }), [{ info: { id: "m1", role: "assistant" }, parts: [{ type: "text", text: "hi" }] }]);
  assert.deepEqual(await engine.agents({ cwd: "/w" }), [{ id: "build", mode: "primary" }]);
  assert.deepEqual(await engine.providers({ cwd: "/w" }), [{ id: "anthropic", name: "Anthropic", models: [{ id: "claude", name: "Claude", variants: [] }] }]);
});

test("HttpRemoteEngine posts the prompt with the selected agent and model", async () => {
  const bodies: unknown[] = [];
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  });
  await engine.prompt({ sessionId: "ses_1", cwd: "/w", text: "go", agent: "plan", model: { providerID: "anthropic", modelID: "claude" } });
  assert.deepEqual(bodies[0], {
    parts: [{ type: "text", text: "go" }],
    agent: "plan",
    model: { providerID: "anthropic", modelID: "claude" },
  });
});

test("HttpRemoteEngine deleteSession issues a DELETE", async () => {
  let method = "";
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    fetch: async (_url, init) => {
      method = init?.method ?? "";
      return new Response(null, { status: 204 });
    },
  });
  await engine.deleteSession({ sessionId: "ses_1", cwd: "/w" });
  assert.equal(method, "DELETE");
});

test("HttpRemoteEngine parses slash commands", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    fetch: async () => new Response(JSON.stringify([{ name: "test", description: "Run tests" }, { name: "init" }, { nope: true }]), { status: 200 }),
  });
  assert.deepEqual(await engine.commands({ cwd: "/w" }), [{ name: "test", description: "Run tests" }, { name: "init" }]);
});

test("HttpRemoteEngine reads the effective config", async () => {
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
    fetch: async () => new Response(JSON.stringify({ permission: { edit: "ask" } }), { status: 200 }),
  });
  assert.deepEqual(await engine.config({ cwd: "/w" }), { permission: { edit: "ask" } });
});
