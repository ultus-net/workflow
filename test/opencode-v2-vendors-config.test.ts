import assert from "node:assert/strict";
import { test } from "node:test";

import { METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import {
  DEFAULT_OPENCODE_MODEL,
  OPENCODE_METERED_PROVIDER_ID,
  OPENCODE_V2_METERED_PROVIDER_ID,
  OPENCODE_V2_VENDOR_BUILTINS,
  meteredOpencodeConfig,
} from "../src/integrations/opencode-agent-config.js";

/**
 * W070a on opencode v2: a config-defined custom provider is not registered into
 * the v2 ACP model catalog (#427), so the open-source vendor pool is emitted as
 * overrides of each family's v2 BUILT-IN provider (`settings.baseURL` only, the
 * v2 "Endpoint" route). The ids/env keys below were confirmed against the pinned
 * opencode v2.0.10 binary (bundled models.dev catalog) and live-probed.
 *
 * v1 is unchanged by construction: its custom-provider emission stays
 * byte-identical (pinned in test/opencode-open-source-config.test.ts).
 */
const proxyUrl = "http://127.0.0.1:61999";

const deepseek = {
  id: "workflow-deepseek",
  name: "Workflow metered (deepseek)",
  baseURL: "http://127.0.0.1:62000",
  models: { "deepseek-flash": { name: "DeepSeek V4.1-Flash" } },
  v2ProviderId: "deepseek",
};
const glm = {
  id: "workflow-glm",
  name: "Workflow metered (glm)",
  baseURL: "http://127.0.0.1:62001/api/paas/v4",
  models: { "glm-5.3": { name: "GLM-5.3" } },
  v2ProviderId: "zai",
};
const kimi = {
  id: "workflow-kimi",
  name: "Workflow metered (kimi)",
  baseURL: "http://127.0.0.1:62002/v1",
  models: { "kimi-k3": { name: "Kimi K3" } },
  v2ProviderId: "moonshotai",
};

test("the v2 vendor built-ins map each open-source family to its catalog id and activation env key", () => {
  assert.deepEqual(OPENCODE_V2_VENDOR_BUILTINS.deepseek, { providerId: "deepseek", envKey: "DEEPSEEK_API_KEY" });
  assert.deepEqual(OPENCODE_V2_VENDOR_BUILTINS.glm, { providerId: "zai", envKey: "ZAI_API_KEY" });
  assert.deepEqual(OPENCODE_V2_VENDOR_BUILTINS.kimi, { providerId: "moonshotai", envKey: "MOONSHOT_API_KEY" });
});

test("v2 emits each vendor as a built-in baseURL override and translates the default model", () => {
  const config = meteredOpencodeConfig({
    proxyUrl,
    opencodeMajor: 2,
    openSource: { providers: [deepseek, glm, kimi], defaultModel: "workflow-deepseek/deepseek-flash" },
  });
  const providers = config.providers as Record<string, Record<string, unknown>>;
  assert.deepEqual((providers.deepseek!.settings as Record<string, unknown>), { baseURL: deepseek.baseURL });
  assert.deepEqual((providers.zai!.settings as Record<string, unknown>), { baseURL: glm.baseURL });
  assert.deepEqual((providers.moonshotai!.settings as Record<string, unknown>), { baseURL: kimi.baseURL });
  // Built-in overrides never declare a custom package or duplicate the catalog.
  for (const id of ["deepseek", "zai", "moonshotai"]) {
    assert.equal(providers[id]!.package, undefined, `${id} must not declare a custom package`);
    assert.equal(providers[id]!.models, undefined, `${id} keeps the built-in catalog`);
  }
  // The metered OpenRouter lane is still composed alongside the vendors.
  assert.deepEqual((providers[OPENCODE_V2_METERED_PROVIDER_ID]!.settings as Record<string, unknown>), { baseURL: `${proxyUrl}/api/v1` });
  assert.equal(config.model, "deepseek/deepseek-flash");
  // The placeholder never enters the v2 config file; it rides the vendor env key.
  assert.ok(!JSON.stringify(config).includes(METERED_PLACEHOLDER_KEY), "the v2 config must stay credential-free");
});

test("v2 honors an explicit operator override on the metered OpenRouter provider even with a vendor pool", () => {
  const config = meteredOpencodeConfig({
    proxyUrl,
    opencodeMajor: 2,
    model: "anthropic/claude-sonnet-4",
    openSource: { providers: [deepseek], defaultModel: "workflow-deepseek/deepseek-flash" },
  });
  assert.equal(config.model, `${OPENCODE_V2_METERED_PROVIDER_ID}/anthropic/claude-sonnet-4`);
});

test("v1 (no opencodeMajor) keeps the custom-provider emission byte-identical even with v2ProviderId set", () => {
  const config = meteredOpencodeConfig({
    proxyUrl,
    openSource: { providers: [deepseek], defaultModel: "workflow-deepseek/deepseek-flash" },
  });
  assert.equal(config.providers, undefined);
  const provider = config.provider as Record<string, Record<string, unknown>>;
  assert.deepEqual(provider["workflow-deepseek"]!.options, { baseURL: deepseek.baseURL, apiKey: METERED_PLACEHOLDER_KEY });
  assert.equal(provider.deepseek, undefined, "v1 never uses built-in ids");
  assert.equal(config.model, "workflow-deepseek/deepseek-flash");
  assert.notEqual(provider[OPENCODE_METERED_PROVIDER_ID], undefined);
});

test("no open-source pool on v2 keeps the Auto Router default", () => {
  const config = meteredOpencodeConfig({ proxyUrl, opencodeMajor: 2 });
  assert.equal(config.model, `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
});
