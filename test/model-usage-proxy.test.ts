import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createModelUsageProxy, METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";

interface FakeUpstream {
  readonly url: string;
  readonly seen: { authorization?: string; body?: string; url?: string; headers?: http.IncomingHttpHeaders }[];
  close(): Promise<void>;
}

async function fakeUpstream(handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void): Promise<FakeUpstream> {
  const seen: FakeUpstream["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry: { authorization?: string; body?: string; url?: string; headers?: http.IncomingHttpHeaders } = {};
      if (typeof req.headers.authorization === "string") entry.authorization = req.headers.authorization;
      entry.body = Buffer.concat(chunks).toString("utf8");
      if (typeof req.url === "string") entry.url = req.url;
      entry.headers = req.headers;
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
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
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
      latestPromptTokens: 120,
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
    assert.equal(proxy.metrics().latestPromptTokens, 10);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy leaves latest prompt tokens unavailable until reported and preserves the last exact value", async () => {
  let request = 0;
  const upstream = await fakeUpstream((_req, _body, res) => {
    request += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: request === 2 ? { prompt_tokens: 42 } : { completion_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    assert.equal(proxy.metrics().latestPromptTokens, undefined);
    await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(proxy.metrics().latestPromptTokens, undefined);
    await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(proxy.metrics().latestPromptTokens, 42);
    await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(proxy.metrics().latestPromptTokens, 42);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy meters SSE data lines split across chunks, preserving bytes", async () => {
  const usagePayload = JSON.stringify({
    id: "1",
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cost: 0.0001 },
  });
  const full = `data: {"choices":[{"delta":{"content":"héllo €"}}]}\n\ndata: ${usagePayload}\n\ndata: [DONE]\n\n`;
  const bytes = Buffer.from(full, "utf8");
  // Split inside the multi-byte € (3-byte UTF-8) and inside the usage JSON so
  // a broken line/decoder reassembly would lose or corrupt the usage chunk.
  const euroByteIndex = Buffer.byteLength(full.slice(0, full.indexOf("€")), "utf8");
  const cuts = [3, euroByteIndex + 1, euroByteIndex + 2, bytes.indexOf(usagePayload) + 9];
  const parts = cuts.map((cut, i) => bytes.subarray(i === 0 ? 0 : cuts[i - 1], cut));
  parts.push(bytes.subarray(cuts[cuts.length - 1]));
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of parts) res.write(part);
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
    const received = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(received, bytes, "split SSE bytes must pass through unchanged");
    assert.equal(proxy.metrics().usageEvents, 1, "usage split across chunks must still meter");
    assert.equal(proxy.metrics().totalTokens, 10);
    assert.equal(proxy.metrics().costUsd, 0.0001);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy strips hop-by-hop and Connection-named request headers", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    // node:http (unlike undici fetch) forwards arbitrary headers, so the
    // hostile hop-by-hop set genuinely reaches the proxy.
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(new URL(`${proxy.url}/api/v1/models`), {
        headers: {
          "proxy-authorization": "Basic ATTACKER",
          te: "trailers",
          "keep-alive": "timeout=5",
          upgrade: "websocket",
          connection: "keep-alive, x-hop",
          "x-hop": "must-not-forward",
          "x-end": "end-to-end",
        },
      });
      request.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 200);
    const headers = upstream.seen[0]?.headers ?? {};
    assert.equal(headers["proxy-authorization"], undefined, "proxy-authorization must never reach the upstream");
    assert.equal(headers.te, undefined, "TE is hop-by-hop and must be stripped");
    assert.equal(headers["keep-alive"], undefined);
    assert.equal(headers.upgrade, undefined);
    assert.equal(headers["x-hop"], undefined, "Connection-named headers must be stripped");
    assert.equal(headers["x-end"], "end-to-end", "end-to-end headers must survive");
    assert.equal(headers.authorization, "Bearer REAL_KEY");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy forwards retry, rate-limit, and redirect response headers", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "2",
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "0",
      "x-upstream-internal": "must-not-forward",
    });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models`);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "2");
    assert.equal(response.headers.get("x-ratelimit-limit"), "100");
    assert.equal(response.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("x-upstream-internal"), null, "non-allowlisted upstream headers stay hidden");
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

test("model usage proxy injects the resolved Auto Router pool for openrouter/auto only", async () => {
  const catalog = {
    data: [
      { id: "~anthropic/claude-sonnet-latest", alias_target: { slug: "anthropic/claude-sonnet-5" } },
      { id: "~openai/gpt-terra-latest", alias_target: { slug: "openai/gpt-5.6-terra" } },
    ],
  };
  const upstream = await fakeUpstream((req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.endsWith("/api/v1/models")) {
      res.end(JSON.stringify(catalog));
      return;
    }
    res.end(JSON.stringify({ choices: [], usage: { total_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: {
      aliases: ["~anthropic/claude-sonnet-latest", "~openai/gpt-terra-latest"],
      costTier: "high",
    },
  });
  try {
    const chatRequests = () => upstream.seen.filter((entry) => entry.url === "/api/v1/chat/completions");

    const auto = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
    });
    assert.equal(auto.status, 200);
    const sent = JSON.parse(chatRequests()[0]?.body ?? "{}") as { model?: string; plugins?: unknown; usage?: unknown };
    assert.deepEqual(sent.plugins, [
      { id: "auto-router", allowed_models: ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"], cost_tier: "high" },
    ]);
    assert.deepEqual(sent.usage, { include: true }, "Auto Router injection must not disable usage accounting");
    assert.equal(sent.model, "openrouter/auto");

    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.1", messages: [] }),
    });
    const sentOther = JSON.parse(chatRequests()[1]?.body ?? "{}") as { plugins?: unknown };
    assert.equal(sentOther.plugins, undefined, "non-auto models must pass through without plugins");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy leaves openrouter/auto untouched when alias resolution is unavailable", async () => {
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ["~anthropic/claude-sonnet-latest"] },
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
    });
    assert.equal(response.status, 200, "a catalog failure must not fail the model request");
    const chat = upstream.seen.find((entry) => entry.url === "/api/v1/chat/completions");
    const sent = JSON.parse(chat?.body ?? "{}") as { plugins?: unknown; usage?: unknown };
    assert.equal(sent.plugins, undefined, "fail open: forward without plugins");
    assert.deepEqual(sent.usage, { include: true });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy honors the Auto Router failure backoff across requests", async () => {
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ["~anthropic/claude-sonnet-latest"], negativeTtlMs: 60_000, now: () => 1_000 },
  });
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
      });
      assert.equal(response.status, 200);
    }
    const modelFetches = upstream.seen.filter((entry) => entry.url === "/api/v1/models");
    assert.equal(modelFetches.length, 1, "a failed catalog fetch must back off, not refetch per request");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy rejects a foreign credential at the boundary and never forwards it (W052)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-attacker-controlled" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { policy?: string; error?: string };
    assert.equal(body.policy, "egress-credential");
    assert.match(body.error ?? "", /authorization/);
    assert.equal(upstream.seen.length, 0, "a foreign credential must never reach the upstream");

    const keyResponse = await fetch(`${proxy.url}/api/v1/models`, {
      headers: { "x-api-key": "sk-attacker-controlled" },
    });
    assert.equal(keyResponse.status, 403);
    assert.equal(upstream.seen.length, 0, "a foreign x-api-key must never reach the upstream");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy still forwards the session placeholder and absent credentials (W052)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const placeholder = await fetch(`${proxy.url}/api/v1/models`, { headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` } });
    assert.equal(placeholder.status, 200);
    const absent = await fetch(`${proxy.url}/api/v1/models`);
    assert.equal(absent.status, 200);
    assert.equal(upstream.seen.length, 2);
    assert.ok(upstream.seen.every((entry) => entry.authorization === "Bearer REAL_KEY"));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
