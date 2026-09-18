import assert from "node:assert/strict";
import test from "node:test";

import { HttpRemoteEngine, sseData, type RemoteEngineEvent } from "../src/integrations/remote-acp/engine.js";

async function* bytes(parts: readonly string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

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
  assert.match(captured[0]!.url, /^http:\/\/127\.0\.0\.1:4096\/global\/health\?directory=%2Fworkspace$/);
  const headers = captured[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from("operator:secret").toString("base64")}`);
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
  const encoder = new TextEncoder();
  const engine = new HttpRemoteEngine({
    baseUrl: "http://127.0.0.1:4096",
    cwd: "/w",
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
  assert.deepEqual(await engine.providers({ cwd: "/w" }), [{ id: "anthropic", name: "Anthropic", models: [{ id: "claude", name: "Claude" }] }]);
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
