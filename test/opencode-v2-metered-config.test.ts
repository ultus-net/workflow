import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPENCODE_MODEL,
  OPENCODE_METERED_PROVIDER_ID,
  OPENCODE_V2_METERED_ENV_KEY,
  OPENCODE_V2_METERED_PROVIDER_ID,
  meteredOpencodeConfig,
} from "../src/integrations/opencode-agent-config.js";

/**
 * The hub-written metered OpenCode config is VERSION-AWARE (verified live on
 * opencode v2.0.10). These pins keep the v1 shape byte-compatible and assert
 * the v2 shape the ACP lane needs: the v2 provider schema
 * (`providers`/`package`/`settings`) reusing the BUILT-IN `openrouter`
 * provider, because a config-defined custom provider is not registered into
 * the v2 ACP model catalog (the live metered probe proves the built-in route).
 */
const proxyUrl = "http://127.0.0.1:61999";

test("v1 (no opencodeMajor) keeps the provider/npm/options shape unchanged", () => {
  const config = meteredOpencodeConfig({ proxyUrl });
  const provider = (config.provider as Record<string, Record<string, unknown>>)[OPENCODE_METERED_PROVIDER_ID]!;
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal((provider.options as Record<string, unknown>).baseURL, `${proxyUrl}/api/v1`);
  assert.equal((provider.options as Record<string, unknown>).apiKey, "workflow-metered");
  assert.equal(config.providers, undefined);
  assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
});

test("v2 emits providers/package|settings and reuses the built-in openrouter provider", () => {
  const config = meteredOpencodeConfig({ proxyUrl, opencodeMajor: 2 });
  assert.equal(config.provider, undefined);
  const providers = config.providers as Record<string, Record<string, unknown>>;
  const openrouter = providers[OPENCODE_V2_METERED_PROVIDER_ID]!;
  assert.equal((openrouter.settings as Record<string, unknown>).baseURL, `${proxyUrl}/api/v1`);
  assert.equal(config.model, `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
  // The placeholder never enters the v2 config file; it rides the env var.
  assert.ok(!JSON.stringify(config).includes("workflow-metered"), "the v2 config must not carry the placeholder in a file");
});

test("v2 honors an explicit model override on the metered OpenRouter provider", () => {
  const config = meteredOpencodeConfig({ proxyUrl, model: "anthropic/claude-sonnet-4", opencodeMajor: 2 });
  assert.equal(config.model, `${OPENCODE_V2_METERED_PROVIDER_ID}/anthropic/claude-sonnet-4`);
});

test("v2 declares open-source vendor providers in the v2 package/settings shape", () => {
  const config = meteredOpencodeConfig({
    proxyUrl,
    opencodeMajor: 2,
    openSource: {
      providers: [{ id: "deepseek", name: "Workflow metered (deepseek)", baseURL: "http://127.0.0.1:62000/api/v1", models: { "deepseek-chat": { name: "DeepSeek Chat" } } }],
      defaultModel: "deepseek/deepseek-chat",
    },
  });
  const providers = config.providers as Record<string, Record<string, unknown>>;
  const vendor = providers.deepseek!;
  assert.equal(vendor.package, "@opencode/ai/providers/openai-compatible");
  assert.equal((vendor.settings as Record<string, unknown>).baseURL, "http://127.0.0.1:62000/api/v1");
});

test("the v2 metered env key is the documented OpenRouter credential variable", () => {
  assert.equal(OPENCODE_V2_METERED_ENV_KEY, "OPENROUTER_API_KEY");
});
