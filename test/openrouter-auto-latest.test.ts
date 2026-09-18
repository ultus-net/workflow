import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_AUTO_LATEST_ALIASES,
  aliasTargets,
  applyAutoRouterPlugin,
  autoLatestConfigFromEnv,
  autoLatestModelCatalog,
  autoLatestModelLabel,
  autoRouterPluginId,
  createAliasResolver,
  isAutoRouterModel,
} from "../src/integrations/openrouter-auto-latest.js";

const CATALOG = {
  data: [
    { id: "~anthropic/claude-sonnet-latest", alias_target: { slug: "anthropic/claude-sonnet-5" } },
    { id: "~openai/gpt-terra-latest", alias_target: { slug: "openai/gpt-5.6-terra" } },
    { id: "anthropic/claude-sonnet-5" },
    { id: "~broken/alias-latest", alias_target: { name: "no slug" } },
    { id: 42 },
  ],
};

function catalogFetch(payload: unknown, counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter !== undefined) counter.calls += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("aliasTargets extracts ~alias -> target slug and ignores malformed rows", () => {
  const targets = aliasTargets(CATALOG);
  assert.equal(targets.get("~anthropic/claude-sonnet-latest"), "anthropic/claude-sonnet-5");
  assert.equal(targets.get("~openai/gpt-terra-latest"), "openai/gpt-5.6-terra");
  assert.equal(targets.has("anthropic/claude-sonnet-5"), false, "concrete ids are not aliases");
  assert.equal(targets.has("~broken/alias-latest"), false, "missing slug is skipped");
  assert.equal(aliasTargets(null).size, 0);
  assert.equal(aliasTargets({ data: "nope" }).size, 0);
});

test("isAutoRouterModel and autoRouterPluginId cover auto and auto-beta", () => {
  assert.equal(isAutoRouterModel("openrouter/auto"), true);
  assert.equal(isAutoRouterModel("openrouter/auto-beta"), true);
  assert.equal(isAutoRouterModel("openrouter/auto/extra"), false);
  assert.equal(isAutoRouterModel(undefined), false);
  assert.equal(autoRouterPluginId("openrouter/auto"), "auto-router");
  assert.equal(autoRouterPluginId("openrouter/auto-beta"), "auto-beta-router");
  assert.equal(autoRouterPluginId("unknown"), "auto-router");
});

test("applyAutoRouterPlugin injects, replaces an existing pool, and preserves other plugins", () => {
  const body = {
    model: "openrouter/auto",
    plugins: [
      { id: "web" },
      { id: "auto-router", allowed_models: ["stale/model"] },
    ],
  };
  const routed = applyAutoRouterPlugin(body, "openrouter/auto", ["anthropic/claude-sonnet-5"], "high");
  assert.deepEqual(routed.plugins, [
    { id: "web" },
    { id: "auto-router", allowed_models: ["anthropic/claude-sonnet-5"], cost_tier: "high" },
  ]);
  assert.deepEqual(body.plugins, [
    { id: "web" },
    { id: "auto-router", allowed_models: ["stale/model"] },
  ], "input body must not be mutated");
});

test("applyAutoRouterPlugin targets the auto-beta plugin id and omits cost_tier when unset", () => {
  const routed = applyAutoRouterPlugin({ model: "openrouter/auto-beta" }, "openrouter/auto-beta", ["openai/gpt-terra"]);
  assert.deepEqual(routed.plugins, [{ id: "auto-beta-router", allowed_models: ["openai/gpt-terra"] }]);
});

test("applyAutoRouterPlugin does not add cost_tier for an empty string", () => {
  const routed = applyAutoRouterPlugin({}, "openrouter/auto", ["x/y"], "");
  assert.deepEqual(routed.plugins, [{ id: "auto-router", allowed_models: ["x/y"] }]);
});

test("createAliasResolver resolves aliases, caches within ttl, and skips missing ones", async () => {
  const counter = { calls: 0 };
  const resolver = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~anthropic/claude-sonnet-latest", "~does-not-exist", "~openai/gpt-terra-latest"],
    fetch: catalogFetch(CATALOG, counter),
    now: () => 1_000,
    ttlMs: 60_000,
  });
  assert.deepEqual(await resolver.resolve(), ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"]);
  assert.deepEqual(await resolver.resolve(), ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"]);
  assert.equal(counter.calls, 1, "second resolve must be served from cache");
});

test("createAliasResolver refetches after the ttl expires", async () => {
  const counter = { calls: 0 };
  let now = 1_000;
  const resolver = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~anthropic/claude-sonnet-latest"],
    fetch: catalogFetch(CATALOG, counter),
    now: () => now,
    ttlMs: 60_000,
  });
  await resolver.resolve();
  now += 61_000;
  await resolver.resolve();
  assert.equal(counter.calls, 2, "expired cache must refetch");
});

test("createAliasResolver fails open: last known pool survives a failure, empty without one", async () => {
  const failing: typeof fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  let now = 1_000;
  const resolver = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~anthropic/claude-sonnet-latest"],
    fetch: async (input, init) => {
      if (now === 1_000) return catalogFetch(CATALOG)(input, init);
      return failing(input, init);
    },
    now: () => now,
    ttlMs: 60_000,
  });
  assert.deepEqual(await resolver.resolve(), ["anthropic/claude-sonnet-5"]);
  now += 61_000;
  assert.deepEqual(await resolver.resolve(), ["anthropic/claude-sonnet-5"], "failure must not drop the cached pool");

  const cold = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~anthropic/claude-sonnet-latest"],
    fetch: failing,
  });
  assert.deepEqual(await cold.resolve(), [], "no cache means an empty pool, never a throw");
});

test("createAliasResolver treats a non-2xx catalog response as failure", async () => {
  const resolver = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~anthropic/claude-sonnet-latest"],
    fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
  });
  assert.deepEqual(await resolver.resolve(), []);
});

test("createAliasResolver caches a successful zero-match resolution within the ttl", async () => {
  const counter = { calls: 0 };
  const resolver = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~does-not-exist"],
    fetch: catalogFetch(CATALOG, counter),
    now: () => 1_000,
    ttlMs: 60_000,
  });
  assert.deepEqual(await resolver.resolve(), []);
  assert.deepEqual(await resolver.resolve(), []);
  assert.equal(counter.calls, 1, "a zero-match result is a successful observation and must be cached");
});

test("createAliasResolver backs off after a cold failure instead of refetching every request", async () => {
  const counter = { calls: 0 };
  let now = 1_000;
  const resolver = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~anthropic/claude-sonnet-latest"],
    fetch: (async () => {
      counter.calls += 1;
      throw new Error("network down");
    }) as unknown as typeof fetch,
    now: () => now,
    negativeTtlMs: 30_000,
  });
  assert.deepEqual(await resolver.resolve(), []);
  now += 10_000;
  assert.deepEqual(await resolver.resolve(), []);
  assert.equal(counter.calls, 1, "within the backoff window the resolver must not refetch");
});

test("createAliasResolver recovers after the backoff window when the catalog returns", async () => {
  const counter = { calls: 0 };
  let now = 1_000;
  let healthy = false;
  const resolver = createAliasResolver({
    modelsUrl: "https://openrouter.ai/api/v1/models",
    aliases: ["~anthropic/claude-sonnet-latest"],
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      counter.calls += 1;
      if (!healthy) throw new Error("network down");
      return catalogFetch(CATALOG)(input, init);
    }) as unknown as typeof fetch,
    now: () => now,
    negativeTtlMs: 30_000,
  });
  assert.deepEqual(await resolver.resolve(), [], "cold failure yields an empty pool");
  healthy = true;
  now += 31_000;
  assert.deepEqual(await resolver.resolve(), ["anthropic/claude-sonnet-5"], "a healthy catalog after backoff repopulates the pool");
  assert.equal(counter.calls, 2);
});

test("autoLatestModelLabel gives friendly picker names, including derived fallbacks", () => {
  assert.equal(autoLatestModelLabel("~anthropic/claude-sonnet-latest"), "Claude Sonnet (latest)");
  assert.equal(autoLatestModelLabel("~openai/gpt-terra-latest"), "GPT Terra (latest)");
  assert.equal(autoLatestModelLabel("~deepseek/deepseek-v4-flash-latest"), "DeepSeek V4 Flash (latest)");
  assert.equal(autoLatestModelLabel("~acme/super-model-v9-latest"), "Super Model V9 (latest)");
  assert.equal(autoLatestModelLabel("~acme/gpt-9000-latest"), "GPT 9000 (latest)");
});

test("autoLatestModelCatalog maps each alias to a picker name", () => {
  assert.deepEqual(autoLatestModelCatalog(["~anthropic/claude-opus-latest", "~x-ai/grok-latest"]), {
    "~anthropic/claude-opus-latest": { name: "Claude Opus (latest)" },
    "~x-ai/grok-latest": { name: "Grok (latest)" },
  });
});

test("DEFAULT_AUTO_LATEST_ALIASES all resolve to friendly labels", () => {
  for (const alias of DEFAULT_AUTO_LATEST_ALIASES) {
    const label = autoLatestModelLabel(alias);
    assert.ok(label.length > 0, `${alias} must have a label`);
    assert.match(label, /\(latest\)$/, `${alias} label should be marked latest`);
  }
});

test("autoLatestConfigFromEnv defaults on for OpenRouter and off elsewhere", () => {
  const on = autoLatestConfigFromEnv({ upstream: "https://openrouter.ai", env: {} });
  assert.deepEqual(on?.aliases, DEFAULT_AUTO_LATEST_ALIASES);
  assert.equal(on?.costTier, undefined);
  assert.equal(autoLatestConfigFromEnv({ upstream: "https://example.com", env: {} }), undefined);
  assert.equal(autoLatestConfigFromEnv({ upstream: "not a url", env: {} }), undefined);
});

test("autoLatestConfigFromEnv honors the disable toggle, custom aliases, and cost tier", () => {
  assert.equal(
    autoLatestConfigFromEnv({ upstream: "https://openrouter.ai", env: { WORKFLOW_OPENROUTER_AUTO_LATEST: "0" } }),
    undefined,
  );
  assert.equal(
    autoLatestConfigFromEnv({ upstream: "https://openrouter.ai", env: { WORKFLOW_OPENROUTER_AUTO_LATEST: "false" } }),
    undefined,
  );
  const custom = autoLatestConfigFromEnv({
    upstream: "https://openrouter.ai",
    env: {
      WORKFLOW_OPENROUTER_AUTO_ALIASES: "~anthropic/claude-opus-latest, ~openai/gpt-terra-latest",
      WORKFLOW_OPENROUTER_AUTO_COST_TIER: "high",
    },
  });
  assert.deepEqual(custom?.aliases, ["~anthropic/claude-opus-latest", "~openai/gpt-terra-latest"]);
  assert.equal(custom?.costTier, "high");
});

test("autoLatestConfigFromEnv falls back to the default pool for a blank alias override", () => {
  const config = autoLatestConfigFromEnv({
    upstream: "https://eu.openrouter.ai",
    env: { WORKFLOW_OPENROUTER_AUTO_ALIASES: "   " },
  });
  assert.deepEqual(config?.aliases, DEFAULT_AUTO_LATEST_ALIASES);
});
