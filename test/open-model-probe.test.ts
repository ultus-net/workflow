import assert from "node:assert/strict";
import test from "node:test";

import { modelProfile, shapeRequestBody } from "../src/integrations/model-profile.js";
import { loadOpenModelKeys } from "../src/integrations/open-model-keys.js";
import { createOpenModelMeteringPool } from "../src/integrations/open-model-proxy.js";

/**
 * W070a live probe: one real chat completion per keyed open-source vendor,
 * sent through the composed loopback metering proxy (placeholder key inside,
 * real key proxy-side). Gated by WORKFLOW_OPEN_MODEL_LIVE=1 AND a vendor key
 * (env or ~/.config/workflow/<family>-api-key); without a key it skips and the
 * item's evidence note records the gap honestly.
 */

const gated = process.env.WORKFLOW_OPEN_MODEL_LIVE === "1";
const { keys, missing } = loadOpenModelKeys();
const families = Object.keys(keys) as Array<keyof typeof keys>;
const skip = !gated
  ? "WORKFLOW_OPEN_MODEL_LIVE is not 1"
  : families.length === 0
    ? "no open-source vendor key present (env or ~/.config/workflow/<family>-api-key)"
    : false;

test("each keyed open-source vendor completes through the metering proxy", { skip, timeout: 180_000 }, async () => {
  const pool = await createOpenModelMeteringPool({ keys });
  try {
    for (const provider of pool.providers) {
      for (const model of provider.models) {
        const body = shapeRequestBody(modelProfile({ family: provider.family, model, taskClass: "general" }), {
          model,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
          max_tokens: 8,
          stream: false,
        });
        const response = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer workflow-metered" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        assert.equal(response.status, 200, `${provider.family}/${model} failed: ${text.slice(0, 400)}`);
        const payload = JSON.parse(text) as { choices?: unknown[] };
        assert.ok(Array.isArray(payload.choices) && payload.choices.length > 0, `${provider.family}/${model} returned no choices`);
      }
    }
    assert.ok(pool.metrics().usageEvents > 0, "at least one usage event must be metered");
    console.log(`open-model probe: ${families.join(", ")} ok; missing keys: ${missing.join(", ") || "none"}`);
  } finally {
    await pool.close();
  }
});
