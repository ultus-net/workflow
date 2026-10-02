import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import { composeBodyTransforms, createModelUsageProxy, METERED_PLACEHOLDER_KEY, type EgressObservation } from "../src/integrations/model-usage-proxy.js";
import type { EgressPolicy } from "../src/integrations/egress-policy.js";

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
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
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

// ---- W179 (NVIDIA adoption wave A2): the SECOND credential gate. Gate 1
// (checkEgressCredential) validates the request's own credential; gate 2
// (checkCredentialEndpoint) validates that the credential binding covers the
// destination. Both must pass; each alone grants nothing.
test("model usage proxy refuses an out-of-binding destination even with the session placeholder (gate 2, W179)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const rejections: unknown[] = [];
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    credentialEndpoints: [{ host: "127.0.0.1", pathPrefix: "/api/v1/allowlisted-only" }],
    onCredentialEndpointRejected: (event) => rejections.push(event),
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models`, { headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` } });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { policy?: string; error?: string };
    assert.equal(body.policy, "credential_endpoint_mismatch");
    assert.equal(upstream.seen.length, 0, "an out-of-binding destination must never reach the upstream");
    // The refusal event carries only value-free destination facts.
    assert.deepEqual(rejections[0], { policy: "credential_endpoint_mismatch", host: "127.0.0.1", port: Number(new URL(upstream.url).port), pathname: "/api/v1/models" });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy gate 1 alone grants nothing: a foreign credential is refused even when the endpoint binding covers it (W179)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    credentialEndpoints: [{ host: "127.0.0.1", pathPrefix: "/api/v1" }],
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models`, { headers: { authorization: "Bearer sk-attacker-controlled" } });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { policy?: string };
    // Gate 1 fires first and labels the refusal under its own policy family.
    assert.equal(body.policy, "egress-credential");
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy injects when both gates pass, and gate 2 refuses a disallowed port (W179)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const port = Number(new URL(upstream.url).port);
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    credentialEndpoints: [{ host: "127.0.0.1", port, pathPrefix: "/api/v1" }],
  });
  try {
    const allowed = await fetch(`${proxy.url}/api/v1/models`, { headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` } });
    assert.equal(allowed.status, 200);
    assert.equal(upstream.seen[0]?.authorization, "Bearer REAL_KEY");
  } finally {
    await proxy.close();
    await upstream.close();
  }

  const portBound = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const mismatched = await createModelUsageProxy({
    upstream: portBound.url,
    apiKey: "REAL_KEY",
    // A port that cannot match the loopback test server's ephemeral port.
    credentialEndpoints: [{ host: "127.0.0.1", port: 1, pathPrefix: "/api/v1" }],
  });
  try {
    const response = await fetch(`${mismatched.url}/api/v1/models`, { headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` } });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { policy?: string }).policy, "credential_endpoint_mismatch");
    assert.equal(portBound.seen.length, 0);
  } finally {
    await mismatched.close();
    await portBound.close();
  }
});

test("model usage proxy gate-2 refusal log-hygiene: neither secret, placeholder, nor query string leaks (W179)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const events: unknown[] = [];
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_SECRET_KEY",
    credentialEndpoints: [{ host: "127.0.0.1", pathPrefix: "/api/v1/allowed-only" }],
    onCredentialEndpointRejected: (event) => events.push(event),
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models?api_key=QUERY_SECRET_VALUE&token=leak`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 403);
    const text = await response.text();
    // Response body hygiene: no secret, no placeholder, no query string.
    assert.equal(text.includes("REAL_SECRET_KEY"), false, "response must not leak the upstream secret");
    assert.equal(text.includes(METERED_PLACEHOLDER_KEY), false, "response must not leak the placeholder");
    assert.equal(text.includes("QUERY_SECRET_VALUE"), false, "response must not leak the query string");
    assert.equal(text.includes("api_key="), false, "response must not include the raw query");
    // Captured log-event hygiene: the value-free position is enforced here too.
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("REAL_SECRET_KEY"), false, "log event must not leak the upstream secret");
    assert.equal(serialized.includes(METERED_PLACEHOLDER_KEY), false, "log event must not leak the placeholder");
    assert.equal(serialized.includes("QUERY_SECRET_VALUE"), false, "log event must not leak the query string");
    assert.equal(serialized.includes("api_key="), false, "log event must not include the raw query");
    assert.deepEqual(events[0], { policy: "credential_endpoint_mismatch", host: "127.0.0.1", port: Number(new URL(upstream.url).port), pathname: "/api/v1/models" });
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model usage proxy with no credential binding preserves today's behavior (gate 2 inactive, W179)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    // A path a binding would have refused is forwarded unchanged with no binding set.
    const response = await fetch(`${proxy.url}/api/v1/anything`, { headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` } });
    assert.equal(response.status, 200);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0]?.authorization, "Bearer REAL_KEY");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---- W109 (W095 c2): the transformBody seam shaped for policy routing —
// the composition helper lets a second consumer (the budget-downgrade
// rewrite the W095 design note names) attach in order, with the SAME
// pass-through posture: no transforms or all-non-record returns leave the
// body untouched. ----

test("W109: composeBodyTransforms chains transforms in order with per-stage fail-open", () => {
  const first = (body: Record<string, unknown>) => ({ ...body, stage: 1 });
  const second = (body: Record<string, unknown>) => ({ ...body, stage: 2 });
  const composed = composeBodyTransforms([first, second]);
  assert.deepEqual(composed({ original: true }), { original: true, stage: 2 });
  // A misbehaving stage (non-record return) is skipped; the chain continues
  // with the last good body — the proxy's own fail-open semantics, per
  // stage.
  const broken = (): string => "not a record";
  assert.deepEqual(composeBodyTransforms([first, broken as unknown as typeof second, second])({ original: true }), { original: true, stage: 2 });
  assert.deepEqual(composeBodyTransforms([broken as unknown as typeof first, first])({ original: true }), { original: true, stage: 1 });
  // A THROWING stage is contained too (frontier round 1 P2): the fail-open
  // extends to exceptions, so a buggy policy consumer cannot 502 the pool.
  const thrower = (): Record<string, unknown> => {
    throw new Error("policy stage bug");
  };
  assert.deepEqual(composeBodyTransforms([first, thrower, second])({ original: true }), { original: true, stage: 2 });
  assert.deepEqual(composeBodyTransforms([thrower])({ original: true }), { original: true });
  // No transforms: the body passes through untouched.
  assert.deepEqual(composeBodyTransforms([])({ original: true }), { original: true });
});

// ── W123: the anthropic Messages lane meters honestly (park P9 part 1) ──────

// The recorded gap (park P9): the metering pipeline gates on /chat/completions
// — the anthropic messages path passed through UNTRANSFORMED and effectively
// UNMETERED, and the W109 review round-1 nuance sharpened the fix: the lane
// DOES reach recordUsage, but the OpenAI-shaped extraction keys against the
// anthropic usage shape (input_tokens/output_tokens/cache_*_input_tokens — no
// prompt_tokens/completion_tokens/total_tokens/cost keys), so every anthropic
// event landed as usageEvents += 1 with ZERO tokens: the trail was polluted,
// not absent. The fix keys the extraction on the anthropic wire type and
// normalizes the cache components into the prompt side (anthropic reports them
// OUTSIDE input_tokens; OpenAI's prompt_tokens INCLUDES cached reads — the
// budget caps must mean the same thing on both lanes).
test("W123: the anthropic message JSON lane meters real tokens (the P9 pollution closed)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "glm-5.3",
      stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 40, cache_read_input_tokens: 60 },
    }));
  });
  const seen: Record<string, unknown>[] = [];
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", onUsage: (usage) => seen.push(usage) });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "glm-5.3", max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: false }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(proxy.metrics(), {
      requests: 1,
      usageEvents: 1,
      promptTokens: 220, // 120 input + 40 cache_creation + 60 cache_read (the cross-lane normalization)
      completionTokens: 30,
      totalTokens: 250,
      costUsd: 0, // the anthropic usage carries no cost field — the OpenRouter lane's usage.cost stays the only local cost source
      latestPromptTokens: 220,
      // P12: the cache components meter first-class — the cache-hit savings
      // are observable in the metrics trail, not just on the raw wire record.
      cacheReadTokens: 60,
      cacheCreateTokens: 40,
    }, "the anthropic usage shape must record real tokens, not zeros");
    // The raw anthropic fields ride onUsage untouched — P12's seam: the raw
    // wire record still rides even though the model now meters the cache
    // fields first-class (consumers that need the exact shape keep it).
    assert.deepEqual(seen, [{ input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 40, cache_read_input_tokens: 60 }]);
    // The anthropic lane stays untransformed: no usage.include injection (the
    // messages wire always reports usage), the body forwards untouched.
    assert.deepEqual(JSON.parse(upstream.seen[0]?.body ?? "{}"), {
      model: "glm-5.3",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }, "the messages lane forwards without the chat-completions body seam");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// The anthropic SSE stream's usage events are CUMULATIVE, not deltas: both
// message_start (message.usage) and message_delta (usage) carry the cache
// fields, and message_delta re-carries the totals (the SDK types mark them
// "cumulative — not a delta!"; summing across events double-counts — the
// recorded cautionary instance is langchainjs #10249). The metering proxy
// takes the LAST-OBSERVED value per field within one stream and emits ONE
// usage event per message at stream end — matching the JSON lane's event
// count and never double-counting.
test("W123: the anthropic SSE lane accumulates the cumulative stream into ONE usage event", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_02","type":"message","role":"assistant","content":[],"model":"glm-5.3","usage":{"input_tokens":9,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n');
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":9,"output_tokens":23,"cache_creation_input_tokens":20,"cache_read_input_tokens":50}}\n\n');
    res.write('data: {"type":"message_stop"}\n\n');
    res.end();
  });
  const seen: Record<string, unknown>[] = [];
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", onUsage: (usage) => seen.push(usage) });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "glm-5.3", max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.text(), 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_02","type":"message","role":"assistant","content":[],"model":"glm-5.3","usage":{"input_tokens":9,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":9,"output_tokens":23,"cache_creation_input_tokens":20,"cache_read_input_tokens":50}}\n\ndata: {"type":"message_stop"}\n\n', "the stream bytes forward through unchanged");
    assert.deepEqual(proxy.metrics(), {
      requests: 1,
      usageEvents: 1, // ONE event per message — the two usage-bearing events are cumulative, not deltas
      promptTokens: 79, // 9 input + 20 cache_creation + 50 cache_read (the last-observed values, NOT 9+9=18)
      completionTokens: 23, // the cumulative output, NOT 1+23=24
      totalTokens: 102,
      costUsd: 0,
      latestPromptTokens: 79,
      // P12: the SSE accumulator's last-observed cache values meter too.
      cacheReadTokens: 50,
      cacheCreateTokens: 20,
    }, "the cumulative stream must not double-count and must emit one event");
    assert.deepEqual(seen, [{ input_tokens: 9, output_tokens: 23, cache_creation_input_tokens: 20, cache_read_input_tokens: 50 }], "onUsage receives the merged per-message record exactly once");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// Regression hold-outs (green before AND after by design): the detection is
// TYPE-keyed (the wire type the chat-completions lane never carries), so the
// OpenAI lanes and the unrecognized-shape behavior are frozen as-found.
test("W123: an anthropic error payload carries no usage and meters nothing (hold-out)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens is required" } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "glm-5.3", messages: [] }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(proxy.metrics(), {
      requests: 1,
      usageEvents: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      latestPromptTokens: undefined,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }, "no usage record: nothing to meter");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W123: a chat-completions usage with anthropic-style keys still records zeros (type-keyed, as-found hold-out)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { input_tokens: 500, output_tokens: 50 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(proxy.metrics(), {
      requests: 1,
      usageEvents: 1,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      latestPromptTokens: undefined,
      // W123: the OpenAI lane's cached read rides prompt_tokens_details.cached_tokens;
      // this payload carries no such detail (and no prompt_tokens), so the cache
      // components stay measured zeros. OpenAI has no cache-create concept.
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }, "the detection keys on the wire type, not the usage shape — the chat-completions lane behaves exactly as before");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ── W123 (issue #290): the OpenAI cached-subset split (the queued refinement) ─
//
// The OpenAI chat-completions lane reports cached prompt reads as a SUBSET of
// prompt_tokens under `prompt_tokens_details.cached_tokens` (the deployed
// OpenRouter lane served a real read the proxy recorded as 0/0, hiding the
// cache measurement from proxy.metrics()). The split records that subset as
// cacheReadTokens while promptTokens/totalTokens stay unchanged — re-summing
// the cached read into the prompt side would double-count it.
test("W123: the OpenAI chat-completions lane records prompt_tokens_details.cached_tokens as cacheReadTokens (prompt side unchanged)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 20000,
        completion_tokens: 30,
        total_tokens: 20030,
        cost: 0.0042,
        // The live OpenRouter shape (2026-09-30): a real cache read inside prompt_tokens.
        prompt_tokens_details: { cached_tokens: 12032 },
      },
    }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(proxy.metrics(), {
      requests: 1,
      usageEvents: 1,
      promptTokens: 20000, // UNCHANGED: the cached read is already inside prompt_tokens
      completionTokens: 30,
      totalTokens: 20030, // UNCHANGED: no re-sum of the cached subset
      costUsd: 0.0042,
      latestPromptTokens: 20000,
      cacheReadTokens: 12032, // the split
      cacheCreateTokens: 0, // OpenAI has no cache-create concept — measured zero
    }, "the cached subset meters first-class without moving the prompt/total sums");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W123: an absent or garbage prompt_tokens_details records a measured zero (never NaN)", async () => {
  let request = 0;
  const upstream = await fakeUpstream((_req, _body, res) => {
    request += 1;
    res.writeHead(200, { "content-type": "application/json" });
    const usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 5 };
    if (request === 2) usage.prompt_tokens_details = null; // non-record detail
    if (request === 3) usage.prompt_tokens_details = { cached_tokens: "12032" }; // non-numeric
    if (request === 4) usage.prompt_tokens_details = { cached_tokens: Number.POSITIVE_INFINITY }; // non-finite
    if (request === 5) usage.prompt_tokens_details = { cached_tokens: -1 }; // negative
    res.end(JSON.stringify({ choices: [], usage }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(proxy.metrics().cacheReadTokens, 0, "absent/garbage/negative cached_tokens must record a measured zero");
    assert.equal(proxy.metrics().cacheCreateTokens, 0);
    assert.equal(proxy.metrics().promptTokens, 500, "the prompt side is untouched by the cache detail");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W123: a payload carrying both the OpenAI detail and the anthropic-shaped field counts the cached read once", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 40 }, // the OpenAI shape
        cache_read_input_tokens: 40, // the anthropic shape, same read
      },
    }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(proxy.metrics().cacheReadTokens, 40, "the double-count guard: one read, not 80");
    assert.equal(proxy.metrics().cacheCreateTokens, 0);
    assert.equal(proxy.metrics().promptTokens, 100);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// P9 A′ (issue #288, 2026-09-30): the parse-only observability variant of the
// held pass-through stance. The messages lane parses the request body into a
// THROWAWAY record to capture the request-side model id into a bounded journal;
// the forwarded bytes stay byte-identical (no shaping, no markers, no
// downgrade, no reject). This closes W111's "no model labels in the trail" gap
// for the lane WITHOUT entering transform governance — the queued P9 decision
// is unchanged.
test("P9 A′: the messages lane records the request-side model label and forwards the body byte-unchanged", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", model: "glm-5.3", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const body = JSON.stringify({ model: "glm-5.3", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(proxy.messagesLaneLabels(), { models: ["glm-5.3"], malformedBodies: 0 }, "the request-side model id rides the journal");
    assert.equal(upstream.seen[0]?.body, body, "the outbound bytes stay byte-identical to the inbound bytes (no wire transform)");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P9 A′: a malformed messages body is counted, forwarded raw, and never 400s", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const malformed = "{not json";
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: malformed,
    });
    assert.equal(response.status, 200, "the messages lane forwards raw bytes rather than 400ing malformed JSON");
    assert.deepEqual(proxy.messagesLaneLabels(), { models: [], malformedBodies: 1 }, "the malformed body is counted, never rejected");
    assert.equal(upstream.seen[0]?.body, malformed, "the malformed bytes forward untouched");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P9 A′: the model-label journal is bounded and drops the oldest entry", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    for (let index = 0; index < 65; index += 1) {
      await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `model-${index}`, messages: [] }),
      });
    }
    const labels = proxy.messagesLaneLabels();
    assert.equal(labels.models.length, 64, "the journal is bounded at 64 entries");
    assert.equal(labels.models[0], "model-1", "the oldest label dropped once the bound was crossed");
    assert.equal(labels.models[63], "model-64", "the newest label is retained");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P9 A′: the default posture touches nothing — the chat-completions lane never populates the messages journal", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.deepEqual(proxy.messagesLaneLabels(), { models: [], malformedBodies: 0 }, "the chat-completions lane does not populate the messages-lane journal");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// P9 option C (issue #288, 2026-09-30): the messages-lane transform seam. The
// proxy applies `messagesTransformBody` to a parseable POST /v1/messages body
// ONLY; absent, the lane keeps the A′ pass-through posture (outbound bytes
// byte-identical to the inbound bytes). The production consumer is the
// open-model pool's markers-only stage (`test/open-model-proxy.test.ts`); this
// pins the seam and its lane scoping so a marker stage cannot silently widen
// to another lane.
test("P9 C: the messages lane applies the supplied transform; absent, the lane stays byte-unchanged", async (context) => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  context.after(() => upstream.close());
  const calls: string[] = [];
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    messagesTransformBody: (body) => {
      calls.push("messages");
      return { ...body, metadata: { marked: true } };
    },
  });
  try {
    const original = JSON.stringify({ model: "glm-5.3", system: "s", messages: [{ role: "user", content: "hi" }] });
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: original,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["messages"], "the messages transform fires on POST /v1/messages");
    assert.deepEqual(JSON.parse(upstream.seen[0]?.body ?? "{}"), {
      model: "glm-5.3",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      metadata: { marked: true },
    }, "the messages transform's result is the forwarded body");
  } finally {
    await proxy.close();
  }

  const plain = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const original = JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] });
    await fetch(`${plain.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: original,
    });
    assert.equal(upstream.seen[1]?.body, original, "no transform supplied: the messages lane forwards byte-unchanged");
  } finally {
    await plain.close();
  }
});

// P9 option C: the two byte-unchanged guarantees that let a per-family opt-in
// stay DARK for an unlisted family — a stage that returns its input by
// reference must not re-serialize (JSON.stringify could reorder keys or change
// whitespace), and a body that is not a parseable object must pass through raw
// without invoking the stage.
test("P9 C: an identity-returning transform and a malformed body both leave the forwarded bytes byte-identical", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const calls: string[] = [];
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    messagesTransformBody: (body) => {
      calls.push("messages");
      return body; // the dark-family stage: opt-in OFF resolves to the input by reference
    },
  });
  try {
    const original = JSON.stringify({ model: "glm-5.3", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: original,
    });
    assert.equal(upstream.seen[0]?.body, original, "an identity-returning stage never re-serializes the body");

    const malformed = "{not json";
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: malformed,
    });
    assert.equal(calls.length, 1, "the transform is never invoked on an unparseable body");
    assert.equal(upstream.seen[1]?.body, malformed, "a malformed body forwards raw");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P9 A′: a zero-length messages body is counted as malformed, not silently skipped", async () => {
  // P9a-review P3 (a): the messages capture was guarded by `inbound.length > 0`,
  // so an empty POST body was neither parsed nor counted — `malformedBodies`
  // undercounted relative to its documented contract ("bodies that were not a
  // parseable JSON object"). An empty body is not parseable JSON, so it must
  // count; the lane still forwards the empty bytes raw (no 400, pass-through
  // untouched). RED-FIRST: this pin read malformedBodies 0 before the fix.
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: "",
    });
    assert.equal(response.status, 200, "the empty body forwards raw rather than 400ing");
    assert.deepEqual(proxy.messagesLaneLabels(), { models: [], malformedBodies: 1 }, "an empty body is not parseable JSON and must count as malformed");
    assert.equal(upstream.seen[0]?.body, "", "the empty bytes forward untouched");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// P9 A′ review P3 (item 4): the journal is captured but NOT yet surfaced into
// the trail/UI — docs/ledger/P9a-parse-only-labels.md records "no consumer reads
// messagesLaneLabels() yet". This anti-drift pin asserts the boundary cannot
// silently drift: the moment a production consumer under src/ wires the
// accessor, this goes red and the ledger's queued-surfacing note must be
// updated (the LESS-0004 source-artifact-pin precedent). The proxy's own
// definition is the only permitted reference; tests are not production.
test("P9 A′: no production consumer reads messagesLaneLabels yet (queued-surfacing anti-drift pin)", () => {
  const srcRoot = join(process.cwd(), "src");
  const offenders: string[] = [];
  const stack = [srcRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (path === join(srcRoot, "integrations", "model-usage-proxy.ts")) continue;
      if (readFileSync(path, "utf8").includes("messagesLaneLabels")) offenders.push(path);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "messagesLaneLabels has a production consumer now — surface it in the P9a ledger and remove this boundary pin",
  );
});

// P9 option D (issue #288, 2026-09-30): the messages-lane replay integrity
// reject tier. DARK by default — with no `messagesReplayIntegrity` opt-in the
// lane keeps the A′ pass-through posture (byte-unchanged, no reject). When the
// opt-in is explicitly true, an anthropic Messages body the replay policy
// cannot safely replay is refused BEFORE it reaches upstream with a structured,
// named 400. The W070b sanctioned synthetic-tool-call insertion (a matched
// tool_use/tool_result pair) stays allowed.
const DANGLING_TOOL_USE_BODY = JSON.stringify({
  model: "deepseek-flash",
  max_tokens: 64,
  messages: [
    { role: "user", content: "run the tool" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_x", name: "read", input: {} }] },
  ],
});

const SANCTIONED_SYNTHETIC_BODY = JSON.stringify({
  model: "deepseek-flash",
  max_tokens: 64,
  messages: [
    { role: "user", content: "run the tool" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "call the tool", signature: "sig-1" },
        { type: "tool_use", id: "call_seed", name: "read", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_seed", content: "seeded" }] },
  ],
});

test("P9 D: without the opt-in the messages lane stays byte-unchanged even on an unsafe replay shape", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: DANGLING_TOOL_USE_BODY,
    });
    assert.equal(response.status, 200, "the reject tier is dark by default");
    assert.equal(upstream.seen[0]?.body, DANGLING_TOOL_USE_BODY, "without the opt-in the lane forwards byte-unchanged");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P9 D: under the opt-in an unsafe replay shape is refused with the named reason before upstream", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", messagesReplayIntegrity: true });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: DANGLING_TOOL_USE_BODY,
    });
    assert.equal(response.status, 400, "the unsafe replay is refused fail-closed");
    assert.equal(upstream.seen.length, 0, "the refused body never reaches upstream");
    const refusal = await response.json() as { error?: string; policy?: string; violations?: Array<{ code?: string }> };
    assert.match(refusal.error ?? "", /messages-schema replay integrity/, "the refusal carries the named reason");
    assert.equal(refusal.policy, "messages-replay-integrity", "the refusal is structured under its own policy name");
    assert.deepEqual(refusal.violations?.map((violation) => violation.code), ["unanswered-tool-use"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P9 D: under the opt-in the W070b sanctioned synthetic insertion is allowed and forwarded byte-unchanged", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", messagesReplayIntegrity: true });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: SANCTIONED_SYNTHETIC_BODY,
    });
    assert.equal(response.status, 200, "the sanctioned synthetic tool-call path is never false-rejected");
    assert.equal(upstream.seen[0]?.body, SANCTIONED_SYNTHETIC_BODY, "an allowed body forwards byte-unchanged");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P9 D: under the opt-in an unparseable messages body fails closed with the named reason", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", messagesReplayIntegrity: true });
  try {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: "{not json",
    });
    assert.equal(response.status, 400, "an unverifiable body is refused under the integrity opt-in");
    assert.equal(upstream.seen.length, 0);
    const refusal = await response.json() as { policy?: string; violations?: Array<{ code?: string }> };
    assert.equal(refusal.policy, "messages-replay-integrity");
    assert.deepEqual(refusal.violations?.map((violation) => violation.code), ["unparseable-body"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ── W181 (A5, NVIDIA adoption): the egress observation seam ──────────────────
//
// The proxy emits a reach on every forwarded request and a reject at the
// credential boundary, with the fields the `egress-audit-mcp` ledger needs
// (destination, function class, token class, anomaly-relevant facts). The seam
// is OBSERVATION ONLY: it never blocks, delays, or rewrites, and no secret,
// placeholder value, path, or query string crosses it — only a bare hostname,
// a path-derived function-class label, and a closed token class.

test("W181 A5: a forwarded request emits a reach with the destination, function class, and token class", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { total_tokens: 1 } }));
  });
  const seen: EgressObservation[] = [];
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", onEgressObservation: (observation) => seen.push(observation) });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [{
      kind: "reach",
      destination: "127.0.0.1",
      functionClass: "chat-completions",
      tokenClass: "session-placeholder",
      anomalyContext: { credentialHeader: undefined },
    }], "the reach carries the bare hostname, path-derived class, and the placeholder token class");
    assert.deepEqual(proxy.egressObservations(), seen, "the journal mirrors the callback");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W181 A5: a foreign credential emits a reject with the policy tag, function class, and no header value", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const seen: EgressObservation[] = [];
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", onEgressObservation: (observation) => seen.push(observation) });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions?secret=sk-should-never-be-recorded`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-attacker-controlled" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(seen, [{
      kind: "reject",
      destination: "127.0.0.1",
      functionClass: "chat-completions",
      tokenClass: "foreign",
      anomalyContext: { policy: "egress-credential", credentialHeader: "x-api-key" },
    }], "the reject records the header NAME, never its value, and drops the query string");
    assert.ok(!JSON.stringify(seen).includes("sk-attacker-controlled"), "the attacker credential value is never observed");
    assert.ok(!JSON.stringify(seen).includes("secret"), "the query string is never observed");
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W181 A5: absent and placeholder credentials record distinct token classes; a GET /models is models-list", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    await fetch(`${proxy.url}/api/v1/models`);
    await fetch(`${proxy.url}/api/v1/models`, { headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` } });
    const observations = proxy.egressObservations();
    assert.deepEqual(observations.map((observation) => (observation.kind === "reach" ? observation.tokenClass : "reject")), ["absent", "session-placeholder"]);
    assert.deepEqual(observations.map((observation) => (observation.kind === "reach" ? observation.functionClass : "reject")), ["models-list", "models-list"]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W181 A5: the observation journal is bounded and the callback cannot change the pass-through posture", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { total_tokens: 1 } }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    // A throwing observer must never fail the request (fail-open observation).
    onEgressObservation: () => {
      throw new Error("observer bug");
    },
  });
  try {
    for (let index = 0; index < 130; index += 1) {
      const response = await fetch(`${proxy.url}/api/v1/models`);
      assert.equal(response.status, 200, "a throwing observer must not affect the response");
    }
    assert.equal(proxy.egressObservations().length, 128, "the observation journal is bounded at 128 entries");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W181 A5: a gate-2 refusal is observed as a reject, never a reach (W179 integration)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const observations: EgressObservation[] = [];
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    credentialEndpoints: [{ host: "127.0.0.1", pathPrefix: "/api/v1/allowed-only" }],
    onEgressObservation: (observation) => observations.push(observation),
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models`, { headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` } });
    assert.equal(response.status, 403);
    assert.equal(upstream.seen.length, 0, "the refused request never reaches the upstream");
    assert.deepEqual(observations, [{
      kind: "reject",
      destination: "127.0.0.1",
      functionClass: "models-list",
      tokenClass: "session-placeholder",
      anomalyContext: { policy: "credential_endpoint_mismatch", credentialHeader: undefined },
    }], "a gate-2 refusal emits a reject observation and no reach");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W181 A5: an absolute-form target is rejected before any reach is observed", async () => {
  const attacker = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: "https://openrouter.ai", apiKey: "REAL_SECRET_KEY" });
  try {
    const { connect } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1", () => {
        socket.write(`GET ${attacker.url}/exfil HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      socket.on("data", () => undefined);
      socket.on("end", () => resolve());
      socket.on("error", reject);
    });
    assert.deepEqual(proxy.egressObservations(), [], "an unforwarded target produces no reach observation");
  } finally {
    await proxy.close();
    await attacker.close();
  }
});
test("W180 A3: an in-policy path forwards and receives the injected key", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const policy: EgressPolicy = {
    rules: [{ id: "chat", host: "127.0.0.1", methods: ["POST"], paths: ["/api/v1/chat"], mode: "enforce" }],
  };
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", payloadPolicy: { egressPolicy: policy } });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 200, "an in-policy function must forward");
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0]?.authorization, "Bearer REAL_KEY", "the real key is injected only for an allowed function");
    assert.equal(upstream.seen[0]?.url, "/api/v1/chat/completions");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A3: an out-of-policy path is refused with the named label and never reaches upstream", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const events: unknown[] = [];
  const policy: EgressPolicy = {
    rules: [{ id: "chat-only", host: "127.0.0.1", methods: ["POST"], paths: ["/api/v1/chat"], mode: "enforce" }],
  };
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_SECRET_KEY",
    payloadPolicy: { egressPolicy: policy },
    onEgressPolicyRejected: (event) => events.push(event),
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/admin/keys?token=QUERY_SECRET_VALUE`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 403, "an out-of-policy function is refused fail-closed");
    const body = (await response.json()) as { policy?: string; error?: string };
    assert.equal(body.policy, "egress_policy", "the refusal is structured under its own policy family");
    assert.match(body.error ?? "", /denied_by_enforce_rule/, "the named reason is surfaced");
    assert.equal(upstream.seen.length, 0, "the refused function must never reach the upstream");
    // The value-free event carries destination facts only — no secret,
    // placeholder, or query string.
    assert.deepEqual(events[0], {
      policy: "egress_policy",
      host: "127.0.0.1",
      port: Number(new URL(upstream.url).port),
      method: "POST",
      pathname: "/api/v1/admin/keys",
      reason: "denied_by_enforce_rule",
    });
    const serialized = JSON.stringify(events) + JSON.stringify(body);
    assert.equal(serialized.includes("REAL_SECRET_KEY"), false, "no secret may leak");
    assert.equal(serialized.includes(METERED_PLACEHOLDER_KEY), false, "no placeholder may leak");
    assert.equal(serialized.includes("QUERY_SECRET_VALUE"), false, "no query string may leak");
    assert.equal(serialized.includes("token="), false, "no raw query may leak");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A3: a supplied policy denies no_matching_rule (deny-by-default) without changing the W178 core", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const events: unknown[] = [];
  // The policy grants a DIFFERENT host, so the request matches no rule at all.
  const policy: EgressPolicy = { rules: [{ id: "elsewhere", host: "api.example.com", mode: "enforce" }] };
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    payloadPolicy: { egressPolicy: policy },
    onEgressPolicyRejected: (event) => events.push(event),
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models`);
    assert.equal(response.status, 403, "a supplied policy is deny-by-default: an unmatched request is refused");
    assert.equal(((await response.json()) as { policy?: string }).policy, "egress_policy");
    assert.equal((events[0] as { reason?: string }).reason, "no_matching_rule");
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A3: an audit-mode endpoint forwards both a matched and an out-of-scope function (audit_only honored)", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const policy: EgressPolicy = { rules: [{ id: "audited", host: "127.0.0.1", paths: ["/api/v1/chat"], mode: "audit" }] };
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", payloadPolicy: { egressPolicy: policy } });
  try {
    const allowed = await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(allowed.status, 200, "an audit rule that grants the function forwards");
    const auditOnly = await fetch(`${proxy.url}/api/v1/models`);
    assert.equal(auditOnly.status, 200, "an audit-mode endpoint observes-and-forwards an out-of-scope function (audit_only)");
    assert.equal(upstream.seen.length, 2, "the audit endpoint's traffic forwards under its declared posture");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A3: with no policy supplied the default is dark and preserves today's behavior", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/admin/keys`);
    assert.equal(response.status, 200, "the tier is dark by default");
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0]?.authorization, "Bearer REAL_KEY");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A4: the policy/body-transform seam runs before credential injection and never observes the resolved key", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const bodiesSeenByTransform: string[] = [];
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_SECRET",
    transformBody: (body) => {
      // Snapshot exactly what the seam observes. Because injection happens
      // later (in `scrubRequestHeaders`, after this stage), no resolved key can
      // appear here.
      bodiesSeenByTransform.push(JSON.stringify(body));
      return body;
    },
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(bodiesSeenByTransform.length, 1, "the seam runs once before forwarding");
    const observed = bodiesSeenByTransform[0] ?? "";
    assert.equal(observed.includes("REAL_SECRET"), false, "the seam never observes the resolved key");
    assert.equal(observed.includes(METERED_PLACEHOLDER_KEY), false, "the seam never observes the placeholder header either");
    // The real key was injected strictly later, at the forward step.
    assert.equal(upstream.seen[0]?.authorization, "Bearer REAL_SECRET", "injection happens AFTER the transform seam");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A4: a policy-refused request never reaches the body-transform seam", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  let transformCalls = 0;
  const policy: EgressPolicy = { rules: [{ id: "chat", host: "127.0.0.1", paths: ["/api/v1/chat"], mode: "enforce" }] };
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_SECRET",
    transformBody: (body) => {
      transformCalls += 1;
      return body;
    },
    payloadPolicy: { egressPolicy: policy },
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 403, "the policy gate refuses before any transform");
    assert.equal(transformCalls, 0, "a policy-refused request never invokes the body-transform seam");
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A4: a body over the size ceiling is refused with the named error and never forwarded", async () => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const events: unknown[] = [];
  let transformCalls = 0;
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_SECRET",
    transformBody: (body) => {
      transformCalls += 1;
      return body;
    },
    payloadPolicy: { maxRequestBodyBytes: 16 },
    onPayloadSizeRejected: (event) => events.push(event),
  });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "many bytes over the ceiling" }] }),
    });
    assert.equal(response.status, 413, "an oversized body is refused fail-closed");
    const body = (await response.json()) as { policy?: string; error?: string };
    assert.equal(body.policy, "payload_too_large", "the refusal is structured under its own policy family");
    assert.match(body.error ?? "", /size ceiling/, "the named reason is surfaced");
    assert.equal(transformCalls, 0, "the size ceiling precedes the body-transform seam");
    assert.equal(upstream.seen.length, 0, "the refused body never reaches upstream");
    const event = events[0] as { policy: string; limitBytes: number; observedBytes: number };
    assert.equal(event.policy, "payload_too_large");
    assert.equal(event.limitBytes, 16);
    assert.ok(event.observedBytes > 16, "the observed byte count is recorded");
    // Value-free: no body bytes, secret, or placeholder in the event.
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("many bytes"), false);
    assert.equal(serialized.includes("REAL_SECRET"), false);
    assert.equal(serialized.includes(METERED_PLACEHOLDER_KEY), false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("W180 A4: a body at or under the size ceiling forwards; absent leaves behavior unchanged", async (context) => {
  const upstream = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  context.after(() => upstream.close());
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY", payloadPolicy: { maxRequestBodyBytes: 4096 } });
  try {
    const response = await fetch(`${proxy.url}/api/v1/models`);
    assert.equal(response.status, 200, "no body is under any ceiling");
    assert.equal(upstream.seen.length, 1);
  } finally {
    await proxy.close();
  }

  // Dark default: a request over any would-be ceiling forwards when no policy
  // is supplied.
  const dark = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const big = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "x".repeat(8192) }] });
    const response = await fetch(`${dark.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    assert.equal(response.status, 200, "with no size ceiling supplied the default is dark");
    assert.equal(upstream.seen.length, 2);
  } finally {
    await dark.close();
  }
});

