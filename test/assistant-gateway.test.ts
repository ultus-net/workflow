import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ASSISTANT_IDENTITY_HEADER,
  createAssistantGateway,
  handleAssistantRequest,
  loadAssistantGatewayConfig,
  type AssistantGatewayConfig,
} from "../src/integrations/assistant-gateway.js";

interface FakeEgress {
  readonly url: string;
  readonly seen: { body?: string; headers?: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

/**
 * A fake metered-egress upstream. Records the received body and answers the
 * OpenAI-shaped chat-completion response the gateway streams back.
 */
async function fakeEgress(): Promise<FakeEgress> {
  const seen: FakeEgress["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

function config(): AssistantGatewayConfig {
  return {
    version: 1,
    identities: { "user-1": "coding" },
    routes: {
      coding: { route: "coding", systemPrompt: "You are a coding assistant." },
      tutor: { route: "tutor", systemPrompt: "You are a tutor." },
      care: { route: "care", systemPrompt: "You are a care assistant." },
    },
  };
}

/** Builds a standalone assistant gateway in front of a fake egress upstream. */
async function startGateway(): Promise<{ egress: FakeEgress; gateway: Awaited<ReturnType<typeof createAssistantGateway>> }> {
  const egress = await fakeEgress();
  const gateway = await createAssistantGateway({ egressUrl: egress.url, egressMetrics: () => ({ requests: 0, usageEvents: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, latestPromptTokens: undefined, cacheReadTokens: 0, cacheCreateTokens: 0 }), config: config() });
  return { egress, gateway };
}

test("known identity: 200 and the injected system message is first", async () => {
  const { egress, gateway } = await startGateway();
  try {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "user-1" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], temperature: 0.5 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { choices: [{ message: { role: "assistant", content: "ok" } }] });

    const forwarded = JSON.parse(egress.seen[0]?.body ?? "{}") as { messages?: unknown[]; model?: string; temperature?: number };
    assert.deepEqual(forwarded.messages, [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "hi" },
    ]);
    // Every other body field is preserved unchanged.
    assert.equal(forwarded.model, "test-model");
    assert.equal(forwarded.temperature, 0.5);
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("an existing system message is prepended to, never merged", async () => {
  const { egress, gateway } = await startGateway();
  try {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "user-1" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "system", content: "original" }, { role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const forwarded = JSON.parse(egress.seen[0]?.body ?? "{}") as { messages?: unknown[] };
    assert.deepEqual(forwarded.messages, [
      { role: "system", content: "You are a coding assistant." },
      { role: "system", content: "original" },
      { role: "user", content: "hi" },
    ]);
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("unknown identity: 403", async () => {
  const { egress, gateway } = await startGateway();
  try {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "nobody" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { message: "unknown assistant identity", type: "invalid_request_error" } });
    assert.equal(egress.seen.length, 0, "a fail-closed identity must never reach the egress");
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("missing identity header: 403", async () => {
  const { egress, gateway } = await startGateway();
  try {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 403);
    assert.equal(egress.seen.length, 0);
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("malformed JSON body: 400", async () => {
  const { egress, gateway } = await startGateway();
  try {
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [ASSISTANT_IDENTITY_HEADER]: "user-1" },
      body: "{not json",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { message: "invalid JSON body" } });
    assert.equal(egress.seen.length, 0);
  } finally {
    await gateway.close();
    await egress.close();
  }
});

test("non-chat-completions path is not handled", async () => {
  const request = { method: "GET", url: "/v1/models", headers: {} } as unknown as http.IncomingMessage;
  const response = {} as unknown as http.ServerResponse;
  const handled = await handleAssistantRequest(request, response, { egressUrl: "http://127.0.0.1:1", config: config() });
  assert.equal(handled, false);
});

test("loadAssistantGatewayConfig rejects an identity pointing at a missing route", () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-gateway-"));
  const path = join(dir, "routes.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    identities: { "user-1": "coding" },
    routes: { tutor: { route: "tutor", systemPrompt: "You are a tutor." } },
  }));
  assert.throws(() => loadAssistantGatewayConfig(path));
});

test("loadAssistantGatewayConfig loads a valid config", () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-gateway-"));
  const path = join(dir, "routes.json");
  writeFileSync(path, JSON.stringify(config()));
  const loaded = loadAssistantGatewayConfig(path);
  assert.equal(loaded.identities["user-1"], "coding");
  assert.equal(loaded.routes.coding.systemPrompt, "You are a coding assistant.");
});
