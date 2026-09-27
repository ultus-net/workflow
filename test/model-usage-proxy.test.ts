import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { composeBodyTransforms, createModelUsageProxy, METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";

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
      // P12: the OpenAI lane meters no cache components — its prompt_tokens
      // already includes cached reads (the recorded lane asymmetry), so these
      // are measured zeros, not absent data.
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }, "the detection keys on the wire type, not the usage shape — the chat-completions lane behaves exactly as before");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
