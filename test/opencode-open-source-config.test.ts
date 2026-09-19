import assert from "node:assert/strict";
import { test } from "node:test";

import { METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import { DEFAULT_OPENCODE_MODEL, OPENCODE_METERED_PROVIDER_ID, meteredOpencodeConfig } from "../src/integrations/opencode-agent-config.js";

/**
 * W070a: the open-source vendors are exposed as their own metered providers
 * with the placeholder credential; the operator override path for closed
 * models still rides the legacy provider.
 */

const openSource = {
  providers: [
    {
      id: "workflow-deepseek",
      name: "Workflow metered (deepseek)",
      baseURL: "http://127.0.0.1:62000",
      models: { "deepseek-flash": { name: "DeepSeek V4.1-Flash" } },
    },
    {
      id: "workflow-glm",
      name: "Workflow metered (glm)",
      baseURL: "http://127.0.0.1:62001/api/paas/v4",
      models: { "glm-5.3": { name: "GLM-5.3" }, "glm-5.3-flash": { name: "GLM-5.3-Flash" } },
    },
  ],
  defaultModel: "workflow-deepseek/deepseek-flash",
};

test("open-source providers are composed with the placeholder and become the default", () => {
  const config = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", openSource });
  assert.equal(config.model, "workflow-deepseek/deepseek-flash");
  const provider = config.provider as Record<string, Record<string, unknown>>;
  const deepseek = provider["workflow-deepseek"]!;
  assert.deepEqual(deepseek.options, { baseURL: "http://127.0.0.1:62000", apiKey: METERED_PLACEHOLDER_KEY });
  assert.deepEqual(deepseek.models, { "deepseek-flash": { name: "DeepSeek V4.1-Flash" } });
  const glm = provider["workflow-glm"]!;
  assert.deepEqual(glm.options, { baseURL: "http://127.0.0.1:62001/api/paas/v4", apiKey: METERED_PLACEHOLDER_KEY });
  assert.ok((glm.models as Record<string, unknown>)["glm-5.3-flash"] !== undefined);
  assert.ok(provider[OPENCODE_METERED_PROVIDER_ID] !== undefined, "the legacy provider stays available for fallback/override");
});

test("an explicit closed-model override still rides the legacy provider", () => {
  const config = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", model: "openrouter/auto", openSource });
  assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/openrouter/auto`);
});

test("no open-source pool leaves the existing Auto Router default unchanged", () => {
  const config = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999" });
  assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
});
