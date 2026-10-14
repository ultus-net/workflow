import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  createOpencodeServerGateway,
  type OpencodeServerGateway,
} from "../src/integrations/opencode-server-gateway.js";
import {
  ASSISTANT_IDENTITY_HEADER,
  type AssistantGatewayConfig,
} from "../src/integrations/assistant-gateway.js";

/**
 * W193 — the M1 assistant lane at the single-ingress front door.
 *
 * The assistant gateway (W192) is a pure dispatcher (`handleAssistantRequest`)
 * the front door calls AFTER its client credential gate: the ingress credential
 * is still required, and the `x-workflow-user` identity is authorization on top.
 * These tests drive the composed gateway (never the assistant handler in
 * isolation) so the dispatch ORDER — credential gate, then lane, then OpenCode
 * fallthrough — is what is asserted.
 */

interface StubUpstream {
  readonly url: string;
  readonly requests: { readonly method: string; readonly path: string }[];
  close(): Promise<void>;
}

/** A stub OpenCode upstream that answers any forwarded path recognisably. */
async function stubUpstream(): Promise<StubUpstream> {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ from: "opencode-stub" }));
  });
  await listen(server);
  return { url: `http://127.0.0.1:${port(server)}`, requests, close: () => close(server) };
}

interface FakeEgress {
  readonly url: string;
  readonly seen: { readonly body: string; readonly headers: IncomingMessage["headers"] }[];
  close(): Promise<void>;
}

/** A fake metered egress upstream: records the received body/headers. */
async function fakeEgress(): Promise<FakeEgress> {
  const seen: FakeEgress["seen"] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await listen(server);
  return { url: `http://127.0.0.1:${port(server)}`, seen, close: () => close(server) };
}

/** The route policy: `u-1` is the tutor, whose prompt is distinctive. */
function config(): AssistantGatewayConfig {
  return {
    version: 1,
    identities: { "u-1": "tutor" },
    routes: {
      coding: { route: "coding", systemPrompt: "You are a coding assistant." },
      tutor: { route: "tutor", systemPrompt: "You are the tutor." },
      care: { route: "care", systemPrompt: "You are a care assistant." },
    },
  };
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/** A composed front door with the assistant lane attached (or absent). */
async function startGateway(options: {
  readonly upstream: string;
  readonly egressUrl?: string;
  readonly withAssistantLane: boolean;
}): Promise<OpencodeServerGateway> {
  return createOpencodeServerGateway({
    upstream: options.upstream,
    upstreamUsername: "up",
    upstreamPassword: "secret",
    tuiPassword: "tuipw",
    ...(options.withAssistantLane
      ? { assistantRoutes: { config: config(), egressUrl: options.egressUrl! } }
      : {}),
  });
}

test("assistant lane: a bound identity is served by the fake egress with the tutor prompt injected", async (t) => {
  const upstream = await stubUpstream();
  const egress = await fakeEgress();
  const gateway = await startGateway({ upstream: upstream.url, egressUrl: egress.url, withAssistantLane: true });
  t.after(async () => {
    await gateway.close();
    await egress.close();
    await upstream.close();
  });

  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "u-1" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { choices: [{ message: { role: "assistant", content: "ok" } }] });

  const forwarded = JSON.parse(egress.seen[0]?.body ?? "{}") as { messages?: unknown[] };
  assert.deepEqual(forwarded.messages, [
    { role: "system", content: "You are the tutor." },
    { role: "user", content: "hi" },
  ]);
  // The assistant lane never forwarded upstream.
  assert.deepEqual(upstream.requests, []);
});

test("assistant lane: an unbound identity fails closed 403 and the egress is untouched", async (t) => {
  const upstream = await stubUpstream();
  const egress = await fakeEgress();
  const gateway = await startGateway({ upstream: upstream.url, egressUrl: egress.url, withAssistantLane: true });
  t.after(async () => {
    await gateway.close();
    await egress.close();
    await upstream.close();
  });

  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "nope" },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(egress.seen, []);
});

test("assistant lane: the client credential gate precedes the lane (no Basic auth is 401)", async (t) => {
  const upstream = await stubUpstream();
  const egress = await fakeEgress();
  const gateway = await startGateway({ upstream: upstream.url, egressUrl: egress.url, withAssistantLane: true });
  t.after(async () => {
    await gateway.close();
    await egress.close();
    await upstream.close();
  });

  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "u-1" },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(egress.seen, []);
});

test("assistant lane: a non-assistant path still reaches the OpenCode upstream", async (t) => {
  const upstream = await stubUpstream();
  const egress = await fakeEgress();
  const gateway = await startGateway({ upstream: upstream.url, egressUrl: egress.url, withAssistantLane: true });
  t.after(async () => {
    await gateway.close();
    await egress.close();
    await upstream.close();
  });

  const response = await fetch(`${gateway.url}/api/session`, {
    headers: { authorization: basic("opencode", "tuipw") },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { from: "opencode-stub" });
  assert.equal(upstream.requests.at(-1)?.path, "/api/session");
  assert.deepEqual(egress.seen, []);
});

test("assistant lane absent: POST /v1/chat/completions falls through to the OpenCode upstream", async (t) => {
  const upstream = await stubUpstream();
  const gateway = await startGateway({ upstream: upstream.url, withAssistantLane: false });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: basic("opencode", "tuipw"), "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "u-1" },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { from: "opencode-stub" });
  assert.equal(upstream.requests.at(-1)?.path, "/v1/chat/completions");
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
