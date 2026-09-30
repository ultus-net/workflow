import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createOpenModelMeteringPool, openModelProviderId, proxyBaseUrl } from "../src/integrations/open-model-proxy.js";
import type { RunBudget } from "../src/integrations/hub-scheduler.js";
import { METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
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
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
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
      headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "glm-5.3", thinking: { type: "disabled" } }),
    });
    await fetch(`${kimi.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
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
    // P12: the aggregate carries the cache fields; on the all-OpenAI lane
    // they stay at their measured zero (cached reads ride prompt_tokens).
    assert.equal(metrics.cacheReadTokens, 0);
    assert.equal(metrics.cacheCreateTokens, 0);
    assert.equal(openModelProviderId("deepseek"), "workflow-deepseek");
  } finally {
    await pool.close();
    await Promise.all(Object.values(upstreams).map((upstream) => upstream.close()));
  }
});

// ── P15 (b): per-family usage granularity ──────────────────────────────────

// The residual this closes: the pool's metrics() is the cross-family
// aggregate, wired into the W119 abort tier. That aggregate stays
// byte-identical for its consumers; the additive perFamilyMetrics() view
// makes each family's recorded usage/savings observable. The split is
// RECORDED-ONLY — each entry is the family proxy's OWN metrics() (the same
// per-entry records the aggregate sums), never a view-side re-derivation of
// tokens or costs from a request log.
test("P15 (b): perFamilyMetrics attributes each family's recorded usage while the aggregate is unchanged", async () => {
  const upstreams = {
    deepseek: await fakeUpstream({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.001 }),
    glm: await fakeUpstream({ prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, cost: 0.002 }),
  } as const;
  const pool = await createOpenModelMeteringPool({
    keys: { deepseek: "DEEPSEEK_KEY", glm: "GLM_KEY" },
    upstreamOverride: (def) => upstreams[def.family as keyof typeof upstreams].url,
  });
  try {
    for (const family of ["deepseek", "glm"] as const) {
      const provider = pool.byFamily.get(family)!;
      await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
        body: JSON.stringify({ model: provider.models[0], messages: [] }),
      });
    }

    // The pre-P15 aggregate, pinned byte-for-byte across every field.
    const aggregate = {
      requests: 2,
      usageEvents: 2,
      promptTokens: 300,
      completionTokens: 60,
      totalTokens: 360,
      costUsd: 0.003,
      latestPromptTokens: 200,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    };
    assert.deepEqual(pool.metrics(), aggregate, "the cross-family aggregate is unchanged (the abort tier's snapshot)");

    const perFamily = pool.perFamilyMetrics();
    assert.deepEqual([...perFamily.keys()].sort(), ["deepseek", "glm"], "one recorded view per composed family");

    const deepseekMetrics = perFamily.get("deepseek");
    const glmMetrics = perFamily.get("glm");
    assert.deepEqual(deepseekMetrics, {
      requests: 1,
      usageEvents: 1,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.001,
      latestPromptTokens: 100,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }, "deepseek's tokens/cost are attributed to deepseek alone");
    assert.deepEqual(glmMetrics, {
      requests: 1,
      usageEvents: 1,
      promptTokens: 200,
      completionTokens: 40,
      totalTokens: 240,
      costUsd: 0.002,
      latestPromptTokens: 200,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }, "glm's tokens/cost are attributed to glm alone");

    // The view is the per-entry records, not a re-derivation: each entry
    // equals the family proxy's own metrics().
    assert.deepEqual(deepseekMetrics, pool.byFamily.get("deepseek")!.proxy.metrics(), "the view reads the recorded per-entry metrics");
    assert.deepEqual(glmMetrics, pool.byFamily.get("glm")!.proxy.metrics());

    // Additivity: the split is the same sum the aggregate reports (no field
    // removed, none double-counted), and the aggregate did not move when the
    // view was read.
    const summed = {
      requests: deepseekMetrics!.requests + glmMetrics!.requests,
      usageEvents: deepseekMetrics!.usageEvents + glmMetrics!.usageEvents,
      promptTokens: deepseekMetrics!.promptTokens + glmMetrics!.promptTokens,
      completionTokens: deepseekMetrics!.completionTokens + glmMetrics!.completionTokens,
      totalTokens: deepseekMetrics!.totalTokens + glmMetrics!.totalTokens,
      costUsd: deepseekMetrics!.costUsd + glmMetrics!.costUsd,
    };
    assert.deepEqual({ ...aggregate, ...summed }, aggregate, "the per-family views sum to the aggregate");
    assert.deepEqual(pool.metrics(), aggregate, "reading the per-family view leaves the aggregate byte-identical");
    assert.deepEqual(
      Object.keys(deepseekMetrics!).sort(),
      ["cacheCreateTokens", "cacheReadTokens", "completionTokens", "costUsd", "latestPromptTokens", "promptTokens", "requests", "totalTokens", "usageEvents"],
      "the per-family shape is the full ModelUsageMetrics (no field removed)",
    );
  } finally {
    await pool.close();
    await Promise.all(Object.values(upstreams).map((upstream) => upstream.close()));
  }
});

test("P15 (b): a family with no composed proxy is absent from perFamilyMetrics (recorded-only)", async () => {
  const glm = await fakeUpstream({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 });
  const pool = await createOpenModelMeteringPool({
    keys: { glm: "GLM_KEY" },
    upstreamOverride: (def) => (def.family === "glm" ? glm.url : undefined),
  });
  try {
    const perFamily = pool.perFamilyMetrics();
    assert.deepEqual([...perFamily.keys()], ["glm"], "only families with a composed proxy carry a recorded view");
    assert.equal(perFamily.has("deepseek"), false, "no proxy = no recorded usage to report");
    assert.equal(perFamily.has("kimi"), false);
  } finally {
    await pool.close();
    await glm.close();
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

// ---- W109 (W098 c2): an anthropic-wire pool with the cacheMarkers opt-in
// marks the stable composition-time prefixes through the governed pipeline;
// the pool without the opt-in passes through; the definition's wire reaches
// the profile (the pre-change composer dropped it, so anthropic-wire pools
// could not exist). DISCOVERED AND QUEUED: the proxy's metering/transform
// pipeline governs only the /chat/completions path — the anthropic messages
// path passes through unmetered and untransformed (a pre-existing W070b-era
// gap the marker injection's real-traffic effectiveness depends on). ----

test("W109: the anthropic-wire pool marks stable prefixes when opted in and passes through without the opt-in", async (context) => {
  const upstream = await fakeUpstream({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 });
  context.after(() => upstream.close());
  const anthropicDef: OpenModelDefinition = {
    ...DEFAULT_OPEN_SOURCE_POOL[0]!,
    endpoint: "https://api.deepseek.com/anthropic",
    wire: "anthropic",
  };
  const markedPool = await createOpenModelMeteringPool({
    pool: [anthropicDef],
    keys: { deepseek: "DEEPSEEK_KEY" },
    upstreamOverride: () => upstream.url,
    cacheMarkers: true,
  });
  try {
    const deepseek = markedPool.byFamily.get("deepseek")!;
    const response = await fetch(`${deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "deepseek-flash", system: "You are Workflow.", tools: [{ name: "read_file" }], messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const seenBody = JSON.parse(upstream.seen[0]?.body ?? "{}") as {
      system: Array<{ text: string; cache_control?: { type: string } }>;
      tools: Array<{ cache_control?: { type: string } }>;
      messages: unknown;
      reasoning?: { effort: string };
      thinking?: unknown;
    };
    assert.equal(seenBody.system[0]?.cache_control?.type, "ephemeral", "the system block carries the marker on the wire");
    assert.equal(seenBody.tools.at(-1)?.cache_control?.type, "ephemeral", "the last tool carries the breakpoint");
    assert.equal(seenBody.system[0]?.text, "You are Workflow.");
    // The definition's wire reached the profile: the deepseek anthropic
    // shaping branch applies (reasoning object, no thinking field).
    assert.deepEqual(seenBody.reasoning, { effort: "high" });
    assert.equal("thinking" in seenBody, false);
  } finally {
    await markedPool.close();
  }

  const plainPool = await createOpenModelMeteringPool({
    pool: [anthropicDef],
    keys: { deepseek: "DEEPSEEK_KEY" },
    upstreamOverride: () => upstream.url,
  });
  try {
    const deepseek = plainPool.byFamily.get("deepseek")!;
    await fetch(`${deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "deepseek-flash", system: "You are Workflow.", messages: [{ role: "user", content: "hi" }] }),
    });
    const plainBody = JSON.parse(upstream.seen[1]?.body ?? "{}") as { system: unknown; reasoning?: { effort: string } };
    assert.equal(plainBody.system, "You are Workflow.", "no opt-in: the system string passes through unmarked");
    assert.deepEqual(plainBody.reasoning, { effort: "high" }, "the wire shaping still applies without the marker opt-in");
  } finally {
    await plainPool.close();
  }
});

// P14 (issue #293): the composer's cacheMarkers option gains the per-family
// map. One map shared across the keyed families: only the families listed
// `true` are marked; a family omitted from the map stays dark. The boolean
// option remains all-keyed (pinned above at model-profile + here by the
// existing W109 pool test).
test("P14: the pool's per-family cacheMarkers map marks only the opted-in family", async (context) => {
  const upstream = await fakeUpstream({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 });
  context.after(() => upstream.close());
  const pool = await createOpenModelMeteringPool({
    pool: [
      { ...DEFAULT_OPEN_SOURCE_POOL[0]!, endpoint: "https://api.deepseek.com/anthropic", wire: "anthropic" },
      { ...DEFAULT_OPEN_SOURCE_POOL[1]!, endpoint: "https://api.z.ai/api/anthropic", wire: "anthropic" },
    ],
    keys: { deepseek: "DEEPSEEK_KEY", glm: "GLM_KEY" },
    upstreamOverride: () => upstream.url,
    cacheMarkers: { deepseek: true },
  });
  try {
    const ask = async (baseUrl: string, model: string): Promise<void> => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
        body: JSON.stringify({ model, system: "You are Workflow.", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
    };
    await ask(pool.byFamily.get("deepseek")!.baseUrl, "deepseek-flash");
    await ask(pool.byFamily.get("glm")!.baseUrl, "glm-5.3");
    const deepseekBody = JSON.parse(upstream.seen[0]?.body ?? "{}") as { system: unknown };
    const glmBody = JSON.parse(upstream.seen[1]?.body ?? "{}") as { system: unknown };
    assert.equal(Array.isArray(deepseekBody.system), true, "the opted-in deepseek family is marked");
    assert.equal(glmBody.system, "You are Workflow.", "the glm family omitted from the map stays dark");
  } finally {
    await pool.close();
  }
});

// P13 (issue #292): under the opt-in the governed pipeline marks the
// previous turn's end on the anthropic wire, in addition to the static head;
// without the opt-in the messages lane passes through byte-unchanged (so the
// DEFAULT stays byte-identical end to end).
test("P13: the opted-in anthropic-wire pool marks the previous turn's boundary on the wire", async (context) => {
  const upstream = await fakeUpstream({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 });
  context.after(() => upstream.close());
  const anthropicDef: OpenModelDefinition = {
    ...DEFAULT_OPEN_SOURCE_POOL[0]!,
    endpoint: "https://api.deepseek.com/anthropic",
    wire: "anthropic",
  };
  const markedPool = await createOpenModelMeteringPool({
    pool: [anthropicDef],
    keys: { deepseek: "DEEPSEEK_KEY" },
    upstreamOverride: () => upstream.url,
    cacheMarkers: true,
  });
  try {
    const deepseek = markedPool.byFamily.get("deepseek")!;
    await fetch(`${deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({
        model: "deepseek-flash",
        system: "You are Workflow.",
        tools: [{ name: "read_file" }],
        messages: [{ role: "user", content: "turn one" }, { role: "assistant", content: "reply" }],
      }),
    });
    const seen = JSON.parse(upstream.seen[0]?.body ?? "{}") as {
      system: Array<{ cache_control?: { type: string } }>;
      tools: Array<{ cache_control?: { type: string } }>;
      messages: Array<{ content: Array<{ text?: string; cache_control?: { type: string } }> }>;
    };
    assert.equal(seen.system[0]?.cache_control?.type, "ephemeral", "the static system head is marked");
    assert.equal(seen.tools.at(-1)?.cache_control?.type, "ephemeral", "the static last tool is marked");
    const lastBlocks = seen.messages.at(-1)?.content;
    assert.equal(Array.isArray(lastBlocks), true, "the string-content last turn is rewritten to a block array");
    assert.equal(lastBlocks?.at(-1)?.cache_control?.type, "ephemeral", "the previous turn's end carries the boundary breakpoint on the wire");
    // Exactly one conversation breakpoint reaches the wire (the budget discipline).
    const messageMarkers = seen.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control !== undefined).length;
    assert.equal(messageMarkers, 1, "one conversation breakpoint only");
  } finally {
    await markedPool.close();
  }

  const plainPool = await createOpenModelMeteringPool({
    pool: [anthropicDef],
    keys: { deepseek: "DEEPSEEK_KEY" },
    upstreamOverride: () => upstream.url,
  });
  try {
    const deepseek = plainPool.byFamily.get("deepseek")!;
    await fetch(`${deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "assistant", content: "reply" }] }),
    });
    const plain = JSON.parse(upstream.seen[1]?.body ?? "{}") as { messages: Array<{ content: unknown }> };
    assert.equal(plain.messages[0]?.content, "reply", "no opt-in: the per-turn lane passes through byte-unchanged");
  } finally {
    await plainPool.close();
  }
});

// ---- P9 option C (issue #288, 2026-09-30): markers-only on the anthropic
// messages lane. The W109 marker pass (`applyCacheMarkers`) now runs on the
// lane's STATIC HEAD (system block + last tool definition) WHEN the per-family
// opt-in enables that family; no opt-in, or a family omitted from the map,
// forwards byte-unchanged. This is markers ONLY: no shaping, no downgrade, no
// usage.include, no replay gate. The P8 provider-lane probes remain the
// activation gate — the opt-in stays dark by default and nothing here turns it
// on. The per-turn message lane is deliberately unmarked (the P13 boundary
// policy owns it). ----

test("P9 C: the anthropic-wire pool marks the messages lane's static head only when the opt-in enables the family", async (context) => {
  const upstream = await fakeUpstream({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 });
  context.after(() => upstream.close());
  const deepseekDef: OpenModelDefinition = {
    ...DEFAULT_OPEN_SOURCE_POOL[0]!,
    endpoint: "https://api.deepseek.com/anthropic",
    wire: "anthropic",
  };
  const glmDef: OpenModelDefinition = {
    ...DEFAULT_OPEN_SOURCE_POOL[1]!,
    endpoint: "https://api.z.ai/api/anthropic",
    wire: "anthropic",
  };
  const messagesBody = (model: string): string => JSON.stringify({
    model,
    max_tokens: 64,
    system: "You are Workflow.",
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  const markedPool = await createOpenModelMeteringPool({
    pool: [deepseekDef, glmDef],
    keys: { deepseek: "DEEPSEEK_KEY", glm: "GLM_KEY" },
    upstreamOverride: () => upstream.url,
    cacheMarkers: { deepseek: true },
  });
  try {
    const deepseek = markedPool.byFamily.get("deepseek")!;
    const deepseekBody = messagesBody("deepseek-flash");
    const marked = await fetch(`${deepseek.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: deepseekBody,
    });
    assert.equal(marked.status, 200);
    const seenMarked = JSON.parse(upstream.seen[0]?.body ?? "{}") as {
      system: Array<{ text: string; cache_control?: { type: string } }>;
      tools: Array<{ cache_control?: { type: string } }>;
      messages: Array<{ cache_control?: unknown }>;
      reasoning?: unknown;
    };
    assert.equal(seenMarked.system[0]?.cache_control?.type, "ephemeral", "the messages-lane system block carries the marker under the opt-in");
    assert.equal(seenMarked.system[0]?.text, "You are Workflow.");
    assert.equal(seenMarked.tools.at(-1)?.cache_control?.type, "ephemeral", "the last tool definition carries the breakpoint");
    assert.equal(seenMarked.messages[0]?.cache_control, undefined, "the per-turn message lane stays unmarked (the P13 boundary policy owns it)");
    assert.equal("reasoning" in seenMarked, false, "markers-only: the messages lane is never shaped");

    const glm = markedPool.byFamily.get("glm")!;
    const glmBody = messagesBody("glm-5.3");
    const dark = await fetch(`${glm.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: glmBody,
    });
    assert.equal(dark.status, 200);
    assert.equal(upstream.seen[1]?.body, glmBody, "a family omitted from the map forwards byte-unchanged (never ON-by-default)");
  } finally {
    await markedPool.close();
  }

  const darkPool = await createOpenModelMeteringPool({
    pool: [deepseekDef],
    keys: { deepseek: "DEEPSEEK_KEY" },
    upstreamOverride: () => upstream.url,
  });
  try {
    const deepseek = darkPool.byFamily.get("deepseek")!;
    const deepseekBody = messagesBody("deepseek-flash");
    const response = await fetch(`${deepseek.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: deepseekBody,
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.seen[2]?.body, deepseekBody, "no opt-in: the messages lane forwards byte-unchanged (no markers, no transform)");
  } finally {
    await darkPool.close();
  }
});

// W118 (the W095 budget-downgrade consumer, part 1): the transform stage
// composes into the GOVERNED lane — the open-source lane's transformBody
// is the only production consumer of the policy seam, so the end-to-end
// pin runs through the REAL pool composition (LESS-0030: no synthetic
// paths). A session crossing the WARN fraction of its budget has its
// subsequent requests' body.model rewritten to the downgrade target;
// pre-crossing requests are untouched; and the metering trail records
// identically on both sides of the rewrite (the recording mechanics are
// upstream of the model field — the W115/LESS-0036 discipline applied to
// the downgrade). The abort tier is untouched: the guard still cancels
// at the full cap — the downgrade is the softer middle step.
test("W118: a session crossing the budget warn fraction downgrades its model at the governed lane", async (context) => {
  const budget: RunBudget = { maxTotalTokens: 1000 };
  // The usage holder is mutable so the test crosses the warn fraction
  // between requests — the activation is a function of the proxy's own
  // recorded usage, exactly as production wires it.
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
    });
  });
  const seen: string[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;

  const pool = await createOpenModelMeteringPool({
    pool: DEFAULT_OPEN_SOURCE_POOL.filter((def) => def.family === "deepseek"),
    keys: { deepseek: "DEEPSEEK_KEY" },
    upstreamOverride: () => `http://127.0.0.1:${address.port}`,
    budgetDowngrade: { targetModel: "deepseek-flash-cheap", budget, fraction: 0.5 },
  });
  try {
    const deepseek = pool.byFamily.get("deepseek")!;
    const ask = async (model: string): Promise<void> => {
      await fetch(`${deepseek.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
        body: JSON.stringify({ model, messages: [] }),
      });
    };

    // Pre-crossing: 20/1000 tokens — the forwarded model is the original.
    await ask("deepseek-flash");
    assert.equal(JSON.parse(seen[0]!).model, "deepseek-flash", "below the warn fraction the model is untouched");

    // The crossing request: the holder's usage rises to 900, but the
    // activation reads the proxy's RECORDED usage at REQUEST time — and
    // only 20 tokens have landed when request 2 is transformed (response
    // 2's 900 land after it is forwarded). So request 2 still rides the
    // original model: the recorded usage lags the holder by exactly one
    // in-flight request (the LESS-0030 discipline: the pin asserts the
    // REAL timeline, not the test's intent).
    usageHolder.total_tokens = 900;
    await ask("deepseek-flash");
    assert.equal(JSON.parse(seen[1]!).model, "deepseek-flash", "the recorded usage lags the holder: the crossing is not yet observable at request time");

    // The crossing is first observable here: response 2's 900 tokens are
    // recorded, so request 3 — a REMAINING turn — rides the target.
    await ask("deepseek-flash");
    assert.equal(JSON.parse(seen[2]!).model, "deepseek-flash-cheap", "remaining turns downgrade once the crossing lands in the recorded usage");

    // The downgrade persists (sticky at the warn tier).
    await ask("deepseek-flash");
    assert.equal(JSON.parse(seen[3]!).model, "deepseek-flash-cheap", "the downgrade holds");

    // ORDER DISCRIMINATION (the fresh-eyes round-1 P1 — the W109 ordering
    // guidance honored): the deepseek profile's openai-wire shaping adds
    // `thinking` + `reasoning_effort` keyed on body.model. Pre-crossing,
    // the original model's profile shapes the body (artifacts present);
    // after the downgrade, the target has NO pool profile, so with the
    // downgrade composed BEFORE shaping the body carries NO pre-downgrade
    // shaping artifacts — the exact wrong-shape bug the W109 guidance
    // forbids.
    const preCrossing = JSON.parse(seen[0]!);
    assert.equal(preCrossing.thinking?.type, "enabled", "the original model's profile shaping applies pre-downgrade");
    assert.ok(preCrossing.reasoning_effort !== undefined, "the original model's reasoning_effort renders pre-crossing");
    const downgraded = JSON.parse(seen[2]!);
    assert.equal(downgraded.thinking, undefined, "the downgraded body carries NO pre-downgrade shaping artifact (the rewrite composes BEFORE shaping)");
    assert.equal(downgraded.reasoning_effort, undefined, "no reasoning_effort from the pre-downgrade profile either");

    // The metering trail records ALL sides identically: every request
    // (rewritten or not) fed the usage event — the rewrite never skips
    // recording (the recording mechanics are upstream of the model field).
    assert.equal(pool.byFamily.get("deepseek")!.proxy.metrics().requests, 4, "all four requests metered");
    assert.equal(pool.byFamily.get("deepseek")!.proxy.metrics().usageEvents, 4, "all four usage events recorded");
    assert.equal(pool.byFamily.get("deepseek")!.proxy.metrics().totalTokens, 20 + 900 + 900 + 900, "the trail accumulates the real usage, not the rewritten model's");
  } finally {
    await pool.close();
  }
});

// W118: without the downgrade config the lane is byte-unchanged — the
// pass-through posture is the default and a downgrade is an opt-in.
test("W118: absent the downgrade config the model is never rewritten", async (context) => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 100, total_tokens: 5100, cost: 0.5 } }));
    });
  });
  const seen: string[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  context.after(() => server.close());
  const address = server.address() as AddressInfo;

  const pool = await createOpenModelMeteringPool({
    pool: DEFAULT_OPEN_SOURCE_POOL.filter((def) => def.family === "deepseek"),
    keys: { deepseek: "DEEPSEEK_KEY" },
    upstreamOverride: () => `http://127.0.0.1:${address.port}`,
  });
  try {
    const deepseek = pool.byFamily.get("deepseek")!;
    await fetch(`${deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
    });
    assert.equal(JSON.parse(seen[0]!).model, "deepseek-flash", "no downgrade config = the model rides untouched at any usage level");
  } finally {
    await pool.close();
  }
});
