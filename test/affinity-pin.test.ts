import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  affinityPin,
  autoLatestConfigFromEnv,
  narrowToAffinityPin,
  type AffinityPinEvent,
} from "../src/integrations/openrouter-auto-latest.js";
import { createModelUsageProxy, METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import type { RunBudget } from "../src/integrations/hub-scheduler.js";

// ── The affinity-routing implementation pins (issue #297, spec §8) ──────────
//
// The pin narrows the Auto Router's resolved pool to ONE slug — the first
// slug in CONFIGURED alias order, never the first resolved slug — and it is
// OPT-IN, default OFF. The five required pins: determinism, DEGRADED-RESOLVER,
// re-pin, narrowing, unchanged-metering. See
// docs/AFFINITY_ROUTING_SPEC_2026-09-24.md.

const ALIASES = ["~deepseek/deepseek-flash-latest", "~z-ai/glm-latest"] as const;
const SLUG_A = "deepseek/deepseek-v4-flash";
const SLUG_B = "z-ai/glm-5.3";
const TARGET = "z-ai/glm-5.3-flash";
const BUDGET: RunBudget = { maxTotalTokens: 1000 };
const CATALOG = {
  data: [
    { id: ALIASES[0], alias_target: { slug: SLUG_A } },
    { id: ALIASES[1], alias_target: { slug: SLUG_B } },
  ],
};
// A degraded catalog: the FIRST configured alias is unresolvable, the second
// still resolves (the partial-outage shape the configured-order rule exists
// for).
const PARTIAL_CATALOG = {
  data: [{ id: ALIASES[1], alias_target: { slug: SLUG_B } }],
};

interface FakeUpstream {
  readonly url: string;
  readonly seen: { url?: string; body?: string }[];
  close(): Promise<void>;
}

async function fakeUpstream(
  handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void,
): Promise<FakeUpstream> {
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

interface Forwarded {
  model?: string;
  plugins?: Array<{ id?: string; allowed_models?: string[]; cost_tier?: string }>;
  usage?: { include?: boolean };
}

function chatSeen(upstream: FakeUpstream): { url?: string; body?: string }[] {
  return upstream.seen.filter((entry) => entry.url === "/api/v1/chat/completions");
}

function parseForwarded(upstream: FakeUpstream, index: number): Forwarded {
  return JSON.parse(chatSeen(upstream)[index]?.body ?? "{}") as Forwarded;
}

function catalogUpstream(catalog: unknown): Promise<FakeUpstream> {
  return fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(catalog));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { total_tokens: 1 } }));
  });
}

async function ask(proxyUrl: string): Promise<void> {
  await fetch(`${proxyUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
    body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
  });
}

// ── Pin 1: determinism (the pure function) ─────────────────────────────────

test("affinityPin: the FIRST slug in CONFIGURED alias order, deterministic and restart-stable", () => {
  const configured = ["~openai/gpt-terra-latest", "~anthropic/claude-sonnet-latest"];
  assert.equal(affinityPin("executor", undefined, configured), configured[0]);
  // Same configured aliases -> same slug, regardless of call site or order of
  // resolution; role/tier are the declared inputs but do not yet select.
  assert.equal(affinityPin("executor", "strong", configured), affinityPin("reviewer", "cheap", configured));
  assert.equal(affinityPin(undefined, undefined, []), undefined, "no configured aliases -> no pin");
});

test("affinityPin follows configured order, not resolved order", () => {
  // The resolved pool drops the first alias on a partial outage; the pin must
  // NOT silently re-point at the second alias's slug.
  const configured = [ALIASES[0], ALIASES[1]];
  assert.equal(affinityPin("rsi", undefined, configured), ALIASES[0]);
});

test("narrowToAffinityPin keeps exactly the pinned slug; absent pin yields no candidates", () => {
  assert.deepEqual(narrowToAffinityPin([SLUG_A, SLUG_B], SLUG_A), [SLUG_A]);
  assert.deepEqual(narrowToAffinityPin([SLUG_A, SLUG_B], undefined), [], "degraded: the pin is absent, free-route");
  assert.deepEqual(narrowToAffinityPin([SLUG_A], SLUG_B), [], "pinned slug not in the pool -> absent");
});

// ── Pin 2: the opt-in flag is default OFF (env) ────────────────────────────

test("autoLatestConfigFromEnv: affinity is OFF by default and opt-in by flag", () => {
  const off = autoLatestConfigFromEnv({ upstream: "https://openrouter.ai", env: {} });
  assert.equal(off?.affinity, undefined, "default OFF: no affinity option composed");
  const on = autoLatestConfigFromEnv({
    upstream: "https://openrouter.ai",
    env: { WORKFLOW_OPENROUTER_AUTO_AFFINITY: "1" },
  });
  assert.equal(on?.affinity?.enabled, true, "the flag opts the pool in");
  assert.equal(typeof on?.affinity?.onEvent, "function", "the env opt-in carries a default logger (pin/re-pin/degradation are logged)");
});

// ── Pin 5 (narrowing): the injected list is exactly one slug ────────────────

test("affinity opt-in narrows the injected allowed_models to exactly the pinned slug", async () => {
  const events: AffinityPinEvent[] = [];
  const upstream = await catalogUpstream(CATALOG);
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: {
      aliases: ALIASES,
      costTier: "high",
      affinity: { enabled: true, role: "rsi", tier: "strong", onEvent: (event) => events.push(event) },
    },
  });
  try {
    await ask(proxy.url);
    const sent = parseForwarded(upstream, 0);
    assert.deepEqual(sent.plugins, [
      { id: "auto-router", allowed_models: [SLUG_A], cost_tier: "high" },
    ], "the injected list is exactly one slug, the first configured alias's");
    assert.equal(events.filter((event) => event.event === "pin").length, 1, "the pin is logged once");
    assert.equal(events[0]?.slug, SLUG_A);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("affinity DEFAULT OFF: without the opt-in the resolved pool is injected un-narrowed", async () => {
  const upstream = await catalogUpstream(CATALOG);
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: { aliases: ALIASES },
  });
  try {
    await ask(proxy.url);
    assert.deepEqual(parseForwarded(upstream, 0).plugins?.[0]?.allowed_models, [SLUG_A, SLUG_B], "as-found pool");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ── Pin 1 (determinism, integration): restart-stable ───────────────────────

test("affinity is restart-stable: two proxies over the same configured aliases pin the same slug", async () => {
  const first = await catalogUpstream(CATALOG);
  const second = await catalogUpstream(CATALOG);
  const mk = (upstream: FakeUpstream) =>
    createModelUsageProxy({
      upstream: upstream.url,
      apiKey: "REAL_KEY",
      autoLatest: { aliases: ALIASES, affinity: { enabled: true, role: "rsi" } },
    });
  const proxyA = await mk(first);
  const proxyB = await mk(second);
  try {
    await ask(proxyA.url);
    await ask(proxyB.url);
    assert.deepEqual(parseForwarded(first, 0).plugins?.[0]?.allowed_models, [SLUG_A]);
    assert.deepEqual(parseForwarded(second, 0).plugins?.[0]?.allowed_models, [SLUG_A]);
  } finally {
    await proxyA.close();
    await proxyB.close();
    await first.close();
    await second.close();
  }
});

// ── Pin 3: DEGRADED-RESOLVER (pin absent + degradation event + free-route) ──

test("DEGRADED-RESOLVER: an unresolvable pin alias leaves the pin ABSENT and free-routes the resolved pool", async () => {
  const events: AffinityPinEvent[] = [];
  const upstream = await catalogUpstream(PARTIAL_CATALOG);
  const proxy = await createModelUsageProxy({
    upstream: upstream.url,
    apiKey: "REAL_KEY",
    autoLatest: {
      aliases: ALIASES,
      affinity: { enabled: true, role: "rsi", onEvent: (event) => events.push(event) },
    },
  });
  try {
    await ask(proxy.url);
    assert.deepEqual(
      parseForwarded(upstream, 0).plugins?.[0]?.allowed_models,
      [SLUG_B],
      "degraded: the pin is absent, the pool is not silently re-pinned to the later alias",
    );
    assert.equal(events.filter((event) => event.event === "degraded").length, 1, "a degradation event is logged");
    assert.equal(events[0]?.event, "degraded");
    assert.equal(events[0]?.alias, ALIASES[0]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("DEGRADED-RESOLVER: a fail-open resolver ([]) logs degradation and injects nothing", async () => {
  const events: AffinityPinEvent[] = [];
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
    autoLatest: {
      aliases: ALIASES,
      affinity: { enabled: true, role: "rsi", onEvent: (event) => events.push(event) },
    },
  });
  try {
    await ask(proxy.url);
    assert.equal(parseForwarded(upstream, 0).plugins, undefined, "fail open: no injection, Auto Router free-routes");
    assert.equal(events.filter((event) => event.event === "degraded").length, 1);
    assert.equal(events[0]?.reason, "resolver-fail-open");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ── Pin 4: re-pin (budget downgrade -> new pin at the turn boundary) ────────

test("re-pin: an active budget downgrade re-pins the session to the target at the turn boundary", async () => {
  const events: AffinityPinEvent[] = [];
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
    autoLatest: {
      aliases: ALIASES,
      affinity: { enabled: true, role: "rsi", onEvent: (event) => events.push(event) },
    },
    budgetDowngrade: { targetModel: TARGET, budget: BUDGET, fraction: 0.5 },
  });
  try {
    await ask(proxy.url); // pin lands: 20 recorded
    assert.deepEqual(parseForwarded(upstream, 0).plugins?.[0]?.allowed_models, [SLUG_A], "the affinity pin holds pre-crossing");

    usageHolder.total_tokens = 900;
    await ask(proxy.url); // the recorded usage lags: still the pin
    assert.deepEqual(parseForwarded(upstream, 1).plugins?.[0]?.allowed_models, [SLUG_A]);

    await ask(proxy.url); // the crossing is observable: re-pin
    assert.deepEqual(
      parseForwarded(upstream, 2).plugins?.[0]?.allowed_models,
      [TARGET],
      "the downgrade re-pins the narrowed pool to the target",
    );
    assert.equal(parseForwarded(upstream, 2).model, "openrouter/auto", "the session stays on the router");
    const repins = events.filter((event) => event.event === "re-pin");
    assert.equal(repins.length, 1, "the re-pin is a logged, turn-boundary event");
    assert.equal(repins[0]?.slug, TARGET);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ── Pin 5 (unchanged-metering): recording is unaffected by the narrowing ────

test("unchanged-metering: the trail records every request across the narrowing", async () => {
  const events: AffinityPinEvent[] = [];
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
    autoLatest: {
      aliases: ALIASES,
      affinity: { enabled: true, role: "rsi", onEvent: (event) => events.push(event) },
    },
  });
  try {
    await ask(proxy.url);
    await ask(proxy.url);
    const metrics = proxy.metrics();
    assert.equal(metrics.requests, 2);
    assert.equal(metrics.usageEvents, 2);
    assert.equal(metrics.totalTokens, 40, "the narrowed requests record their real usage identically");
    assert.equal(metrics.costUsd, 0.002);
    assert.deepEqual(parseForwarded(upstream, 1).usage, { include: true }, "usage accounting survives the narrowing");
    assert.equal(events.length, 1, "the pin logs once per pin, not per request");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
