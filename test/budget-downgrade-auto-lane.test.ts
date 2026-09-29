import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createModelUsageProxy, METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import type { RunBudget } from "../src/integrations/hub-scheduler.js";
import { budgetDowngradeFromEnv } from "../src/integrations/session-budget.js";

interface FakeUpstream {
  readonly url: string;
  readonly seen: { url?: string; body?: string }[];
  close(): Promise<void>;
}

// The shared fake upstream shape (model-usage-proxy.test.ts's harness): the
// handler decides per request, so one upstream can serve the alias catalog
// (/api/v1/models) and the chat lane (/api/v1/chat/completions) with a
// mutable usage holder — the activation reads the proxy's RECORDED usage at
// request time, exactly as production wires it.
async function fakeUpstream(handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void): Promise<FakeUpstream> {
  const seen: FakeUpstream["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ ...(req.url === undefined ? {} : { url: req.url }), body: Buffer.concat(chunks).toString("utf8") });
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

// The parked P15 (a) fixtures: a two-alias autoLatest pool, a cheap concrete
// downgrade target, a warn fraction of 0.5 on a 1000-token cap.
const ALIASES = ["~deepseek/deepseek-flash-latest", "~z-ai/glm-latest"] as const;
const CATALOG = {
  data: [
    { id: "~deepseek/deepseek-flash-latest", alias_target: { slug: "deepseek/deepseek-v4-flash" } },
    { id: "~z-ai/glm-latest", alias_target: { slug: "z-ai/glm-5.3" } },
  ],
};
const TARGET = "z-ai/glm-5.3-flash";
const BUDGET: RunBudget = { maxTotalTokens: 1000 };

function chatSeen(upstream: FakeUpstream): { url?: string; body?: string }[] {
  return upstream.seen.filter((entry) => entry.url === "/api/v1/chat/completions");
}
function modelsSeen(upstream: FakeUpstream): { url?: string; body?: string }[] {
  return upstream.seen.filter((entry) => entry.url === "/api/v1/models");
}

interface Forwarded {
  model?: string;
  plugins?: Array<{ id?: string; allowed_models?: string[]; cost_tier?: string }>;
  usage?: { include?: boolean };
}

function parseForwarded(upstream: FakeUpstream, index: number): Forwarded {
  return JSON.parse(chatSeen(upstream)[index]?.body ?? "{}") as Forwarded;
}

// ── P15 part (a): the OpenRouter-lane allowed_models-narrowing variant ──────
//
// The W118 downgrade rewrites body.model at the transformBody seam — the
// design note's enforcement for CONCRETE pool models (the routing note's
// round-1 P2 seam split: the allowed_models injection fires only for
// auto-router model sessions). On the autoLatest-composed Auto Router lane a
// body.model rewrite would switch the session OFF the router; the variant
// instead NARROWS the injected allowed_models to the downgrade target —
// narrow-before-inject, the Auto Router keeps resolving, constrained. The
// warn/abort tier posture is untouched: the variant only changes WHERE the
// narrowing lands on the auto lane.

test("P15a: an active downgrade narrows the auto-router allowed_models to the target instead of rewriting the model", async () => {
  // The alias resolution clock is injectable so the post-crossing stretch
  // provably makes NO catalog consult (narrow-before-inject): advance `now`
  // past the cache TTL while the downgrade is active — an implementation that
  // still resolved the pool and narrowed after injection would refetch.
  let now = 1_000;
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CATALOG));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ALIASES, costTier: "high", now: () => now },
    budgetDowngrade: { targetModel: TARGET, budget: BUDGET, fraction: 0.5 },
  });
  const ask = async (): Promise<void> => {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
    });
  };
  try {
    // Pre-crossing (20/1000 recorded): the as-found as-found pool injection —
    // both resolved slugs, the cost tier, the model untouched.
    await ask();
    const pre = parseForwarded(upstream, 0);
    assert.equal(pre.model, "openrouter/auto", "pre-crossing the model stays the Auto Router slug");
    assert.deepEqual(pre.plugins, [
      { id: "auto-router", allowed_models: ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3"], cost_tier: "high" },
    ], "pre-crossing the resolved pool is injected exactly as before");

    // The crossing request: the recorded usage lags the holder by one
    // in-flight request (the W118 timeline semantics) — still the pool.
    usageHolder.total_tokens = 900;
    await ask();
    assert.equal(parseForwarded(upstream, 1).model, "openrouter/auto", "the recorded usage lags: the crossing is not yet observable");
    assert.deepEqual(parseForwarded(upstream, 1).plugins?.[0]?.allowed_models, ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3"]);

    // The crossing lands in the recorded usage: the NARROWING variant —
    // the model stays the router's, the injected constraint is the target
    // alone, and the operator's cost tier survives the narrowing.
    await ask();
    const narrowed = parseForwarded(upstream, 2);
    assert.equal(narrowed.model, "openrouter/auto", "the downgrade must NOT switch the model off the auto-router");
    assert.deepEqual(narrowed.plugins, [
      { id: "auto-router", allowed_models: [TARGET], cost_tier: "high" },
    ], "the injected allowed_models narrows to exactly the downgrade target");

    // Sticky at the warn tier — and the catalog is never re-consulted while
    // the narrowing carries the downgrade (the clock advanced past the cache
    // TTL; narrow-before-inject does not consume the resolution).
    now = 1_000 + 7 * 60 * 60 * 1000;
    await ask();
    const sticky = parseForwarded(upstream, 3);
    assert.equal(sticky.model, "openrouter/auto");
    assert.deepEqual(sticky.plugins?.[0]?.allowed_models, [TARGET], "the narrowing holds");
    assert.equal(modelsSeen(upstream).length, 1, "no catalog fetch after the warm-up: the narrowing does not re-resolve the pool");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P15a: the lane decides — same proxy, the auto lane narrows while a concrete model still gets the W118 rewrite", async () => {
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CATALOG));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
  });
  const transformedModels: unknown[] = [];
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ALIASES },
    budgetDowngrade: { targetModel: TARGET, budget: BUDGET, fraction: 0.5 },
    // The composition-order probe: the caller's transformBody must see the
    // ALREADY-narrowed body (the narrowing lands at the injection, upstream
    // of the transform chain — narrow-before-inject, not a post-transform
    // patch).
    transformBody: (body) => {
      transformedModels.push(body.model);
      return body;
    },
  });
  const ask = async (model: string): Promise<void> => {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model, messages: [] }),
    });
  };
  try {
    // Warm the recorded usage past the warn fraction (20 + 900 = 920 ≥ 500).
    await ask("openrouter/auto");
    usageHolder.total_tokens = 900;
    await ask("openrouter/auto");

    // The auto lane: the variant.
    await ask("openrouter/auto");
    const auto = parseForwarded(upstream, 2);
    assert.equal(auto.model, "openrouter/auto", "the auto lane keeps the router");
    assert.deepEqual(auto.plugins?.[0]?.allowed_models, [TARGET], "the auto lane narrows the injected constraint");
    // Narrow-before-inject: the caller's transformBody ran on the narrowed
    // body — the plugin was already the target-only list when the transform
    // chain received it, and the model it saw was the router's.
    const seenByTransform = JSON.parse(chatSeen(upstream)[2]?.body ?? "{}") as Forwarded;
    assert.equal(transformedModels[2], "openrouter/auto", "the transform chain sees the router model (the narrowing is upstream of the transforms)");
    assert.deepEqual(seenByTransform.plugins?.[0]?.allowed_models, [TARGET], "the transform chain sees the narrowed plugin");

    // The concrete-model lane on the SAME proxy, SAME active downgrade: the
    // W118 recorded target-switch is unchanged.
    await ask("z-ai/glm-5.3");
    const concrete = parseForwarded(upstream, 3);
    assert.equal(concrete.model, TARGET, "the non-auto lane keeps the W118 body.model rewrite");
    assert.equal(concrete.plugins, undefined, "the concrete lane never gains an auto-router plugin");
    assert.equal(transformedModels[3], TARGET, "the transform chain sees the rewritten model (the rewrite composes before the caller's transforms)");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("P15a: narrow-before-inject — an active downgrade does not consume the catalog resolution (an outage cannot un-apply it)", async () => {
  // The catalog endpoint never succeeds: the resolver fails open to []
  // (the as-found posture for the UN-narrowed pool). With the downgrade
  // active the narrowing still lands — the target is operator-configured,
  // not alias-resolved, so a catalog outage cannot silently un-apply it.
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ALIASES },
    budgetDowngrade: { targetModel: TARGET, budget: BUDGET, fraction: 0.5 },
  });
  const ask = async (): Promise<void> => {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
    });
  };
  try {
    // Inactive + dead catalog: the as-found fail-open — no plugin at all.
    await ask();
    assert.equal(parseForwarded(upstream, 0).plugins, undefined, "fail open holds while the downgrade is inactive");

    // Active + dead catalog: the narrowing does not depend on the resolution.
    usageHolder.total_tokens = 900;
    await ask();
    assert.equal(parseForwarded(upstream, 1).model, "openrouter/auto", "the recorded usage lags: still inactive at request time");
    usageHolder.total_tokens = 20;
    await ask();
    const narrowed = parseForwarded(upstream, 2);
    assert.equal(narrowed.model, "openrouter/auto", "the outage must not switch the model off the router either");
    assert.deepEqual(narrowed.plugins?.[0]?.allowed_models, [TARGET], "an active downgrade narrows despite the dead catalog");
    assert.equal(modelsSeen(upstream).length, 1, "the failing catalog is not re-consulted per request (the backoff posture holds)");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// Fail-closed composition: the axes parse (W122's posture) decides whether a
// downgrade exists at all — a malformed axis fails closed to undefined, and
// the undefined result leaves BOTH lanes byte-as-found (the pool injection,
// no rewrite).
test("P15a: malformed axes fail closed to no downgrade — both lanes stay byte-as-found", async () => {
  const messages: string[] = [];
  const axes = budgetDowngradeFromEnv(
    { WORKFLOW_BUDGET_DOWNGRADE_MODEL: TARGET, WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "1.5" },
    (message) => messages.push(message),
  );
  assert.equal(axes, undefined, "the parse fails closed (W122's posture, unchanged)");
  assert.equal(messages.length, 1, "the operator-facing warn still fires");
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CATALOG));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
  });
  // The runtime composition shape: axes is undefined (pinned above), so the
  // option composes nothing — no downgrade rides this proxy at all.
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ALIASES },
  });
  const ask = async (model: string): Promise<void> => {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model, messages: [] }),
    });
  };
  try {
    // Usage far past any would-be warn fraction: no downgrade exists, so the
    // lanes behave exactly as the pre-downgrade proxy did.
    usageHolder.total_tokens = 9000;
    await ask("openrouter/auto");
    const auto = parseForwarded(upstream, 0);
    assert.equal(auto.model, "openrouter/auto", "no downgrade: the auto lane keeps the router");
    assert.deepEqual(auto.plugins, [
      { id: "auto-router", allowed_models: ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3"] },
    ], "no downgrade: the resolved pool is injected un-narrowed (no cost tier configured)");
    await ask("z-ai/glm-5.3");
    const concrete = parseForwarded(upstream, 1);
    assert.equal(concrete.model, "z-ai/glm-5.3", "no downgrade: the concrete model is never rewritten");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// Metering unchanged: the narrowing is a body-shape change upstream of the
// forwarding seam — the trail records every request identically on both
// sides of the narrowing, and the usage-accounting injection survives it.
test("P15a: the metering trail records identically across the narrowing (unchanged pin)", async () => {
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CATALOG));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ALIASES },
    budgetDowngrade: { targetModel: TARGET, budget: BUDGET, fraction: 0.5 },
  });
  const ask = async (): Promise<void> => {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
    });
  };
  try {
    await ask(); // 20 recorded
    usageHolder.total_tokens = 900;
    await ask(); // 20 recorded at request time (lag), 900 recorded from the response
    await ask(); // narrowed
    const metrics = proxy.metrics();
    assert.equal(metrics.requests, 3, "all three requests metered (the narrowed one included)");
    assert.equal(metrics.usageEvents, 3, "all three usage events recorded");
    assert.equal(metrics.totalTokens, 20 + 900 + 900, "the trail accumulates the real usage across the narrowing");
    assert.equal(metrics.costUsd, 0.003, "cost accumulates unchanged (0.001 per response, three responses)");
    assert.deepEqual(parseForwarded(upstream, 2).usage, { include: true }, "the narrowed request still asks the provider for usage accounting");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// The no-seam fallback: with the autoLatest seam UNCOMPOSED (e.g.
// WORKFLOW_OPENROUTER_AUTO_LATEST=0), an openrouter/auto session has no
// injection point to narrow — the recorded conservative fallback is the W118
// rewrite (switch OFF the router to the target). Deliberate, recorded, and
// now pinned so the fallback cannot silently become a no-op downgrade.
test("P15a: without the autoLatest seam the auto-router lane falls back to the W118 rewrite", async () => {
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CATALOG));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
  });
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    budgetDowngrade: { targetModel: TARGET, budget: BUDGET, fraction: 0.5 },
  });
  const ask = async (): Promise<void> => {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
    });
  };
  try {
    await ask(); // 20 recorded
    usageHolder.total_tokens = 900;
    await ask(); // lag: still inactive
    await ask(); // crossed: the rewrite fires (no seam to narrow through)
    assert.equal(parseForwarded(upstream, 2).model, TARGET, "the no-seam fallback rewrites off the router (the recorded conservative fallback)");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});