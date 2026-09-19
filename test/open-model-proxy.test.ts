import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createOpenModelMeteringPool, openModelProviderId, proxyBaseUrl } from "../src/integrations/open-model-proxy.js";
import { DEFAULT_OPEN_SOURCE_POOL, type OpenModelDefinition } from "../src/integrations/open-source-pool.js";
import type { ModelFamily } from "../src/integrations/model-profile.js";

interface FakeUpstream {
  readonly url: string;
  readonly seen: { authorization: string | undefined; url: string | undefined; body: string }[];
  close(): Promise<void>;
}

async function fakeUpstream(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number }): Promise<FakeUpstream> {
  const seen: FakeUpstream["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [], usage }));
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

test("the pool composes one metering proxy per keyed vendor with the real key proxy-side", async () => {
  const upstreams: Record<ModelFamily, FakeUpstream> = {
    deepseek: await fakeUpstream({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.001 }),
    glm: await fakeUpstream({ prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, cost: 0.002 }),
    kimi: await fakeUpstream({ prompt_tokens: 300, completion_tokens: 60, total_tokens: 360, cost: 0.003 }),
  };
  const pool = await createOpenModelMeteringPool({
    keys: { deepseek: "DEEPSEEK_KEY", glm: "GLM_KEY", kimi: "KIMI_KEY" },
    upstreamOverride: (def) => upstreams[def.family].url,
  });
  try {
    assert.deepEqual(pool.providers.map((provider) => provider.providerId), ["workflow-deepseek", "workflow-glm", "workflow-kimi"]);
    const deepseek = pool.byFamily.get("deepseek")!;
    const glm = pool.byFamily.get("glm")!;
    const kimi = pool.byFamily.get("kimi")!;
    assert.deepEqual(deepseek.models, ["deepseek-flash"]);
    assert.deepEqual(glm.models, ["glm-5.3", "glm-5.3-flash"]);
    assert.deepEqual(kimi.models, ["kimi-k3"]);
    assert.equal(deepseek.baseUrl, proxyBaseUrl(deepseek.proxy.url, "https://api.deepseek.com"));
    assert.ok(glm.baseUrl.endsWith("/api/paas/v4"), "GLM's path prefix survives");
    assert.ok(kimi.baseUrl.endsWith("/v1"), "Kimi's path prefix survives");

    const response = await fetch(`${deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer PLACEHOLDER" },
      body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreams.deepseek.seen[0]?.authorization, "Bearer DEEPSEEK_KEY", "proxy injects the real vendor key");
    assert.equal(upstreams.deepseek.seen[0]?.url, "/chat/completions");

    const deepseekBody = JSON.parse(upstreams.deepseek.seen[0]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(deepseekBody.thinking, { type: "enabled" }, "DeepSeek shaping opts into thinking on the wire");
    assert.equal(deepseekBody.reasoning_effort, "high", "the coding effort default is applied");

    await fetch(`${glm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer PLACEHOLDER" },
      body: JSON.stringify({ model: "glm-5.3", thinking: { type: "disabled" } }),
    });
    await fetch(`${kimi.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer PLACEHOLDER" },
      body: JSON.stringify({ model: "kimi-k3", thinking: { type: "disabled" } }),
    });
    const glmBody = JSON.parse(upstreams.glm.seen[0]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(glmBody.thinking, { type: "enabled" }, "GLM never reaches the wire with disabled thinking");
    assert.equal(JSON.stringify(glmBody).includes("\"disabled\""), false, "no disabled marker survives the proxy");
    const kimiBody = JSON.parse(upstreams.kimi.seen[0]?.body ?? "{}") as Record<string, unknown>;
    assert.equal("thinking" in kimiBody, false, "K3 drops the GPT-era thinking field");
    assert.equal(kimiBody.reasoning_effort, "max");

    const metrics = pool.metrics();
    assert.equal(metrics.requests, 3);
    assert.equal(metrics.totalTokens, 120 + 240 + 360, "usage aggregates across vendor proxies");
    assert.equal(metrics.costUsd, 0.006);
    assert.equal(openModelProviderId("deepseek"), "workflow-deepseek");
  } finally {
    await pool.close();
    await Promise.all(Object.values(upstreams).map((upstream) => upstream.close()));
  }
});

test("a vendor without a key starts no proxy (its models fall back to OpenRouter)", async () => {
  const glm = await fakeUpstream({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 });
  const pool = await createOpenModelMeteringPool({
    keys: { glm: "GLM_KEY" },
    upstreamOverride: (def) => (def.family === "glm" ? glm.url : undefined),
  });
  try {
    assert.deepEqual(pool.providers.map((provider) => provider.family), ["glm"]);
    assert.equal(pool.byFamily.has("deepseek"), false);
    assert.equal(pool.byFamily.has("kimi"), false);
  } finally {
    await pool.close();
    await glm.close();
  }
});

test("a family split across endpoints fails closed instead of misrouting", async () => {
  const pool: readonly OpenModelDefinition[] = [
    { ...DEFAULT_OPEN_SOURCE_POOL[1]!, id: "glm-a", endpoint: "https://api.z.ai/api/paas/v4" },
    { ...DEFAULT_OPEN_SOURCE_POOL[1]!, id: "glm-b", model: "glm-other", endpoint: "https://other.example/v1" },
  ];
  await assert.rejects(
    createOpenModelMeteringPool({ pool, keys: { glm: "GLM_KEY" }, upstreamOverride: (def) => def.endpoint }),
    /spans multiple endpoints/,
  );
});
