import assert from "node:assert/strict";
import { test } from "node:test";

import { strictifyToolDefinitions } from "../src/integrations/deepseek-strict-schema.js";
import { enforceReplayPolicy, replayPolicyForModel } from "../src/integrations/model-replay-policy.js";
import { createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import { OPEN_MODEL_GOLDEN_PROBES, type VendorGoldenProbe } from "./fixtures/open-model-golden-probes.js";

/**
 * W070b slice 6: golden-probe corpus skeleton (feeds W062).
 *
 * The deterministic leg runs always and pins the corpus definitions against
 * the policy modules. The live leg is probe-gated; when it cannot run it
 * records the gate state honestly rather than fabricating a verdict.
 */

test("golden-probe corpus definitions agree with the deterministic policy modules", () => {
  assert.equal(OPEN_MODEL_GOLDEN_PROBES.length, 3);
  for (const vendor of OPEN_MODEL_GOLDEN_PROBES) {
    assert.equal(replayPolicyForModel(vendor.model).family !== "unknown", true, `${vendor.vendor} model must classify`);
    for (const check of vendor.checks) {
      if (check.kind === "strict-schema") {
        const tools = strictifyToolDefinitions([
          { type: "function", function: { name: "golden_probe", parameters: vendor.toolSchema } },
        ]);
        const fn = tools[0]?.function;
        assert.equal(fn?.strict, true, `${check.id} must mark strict`);
        assert.equal((fn?.parameters as Record<string, unknown>).additionalProperties, false, check.id);
        continue;
      }
      if (check.kind === "thinking-flags") {
        const policy = replayPolicyForModel(vendor.model);
        assert.equal(JSON.stringify(policy).includes("disabled"), false, `${check.id}: never disable thinking`);
        continue;
      }
      assert.ok(check.replayMessages, `${check.id} needs a replay fixture`);
      const decision = enforceReplayPolicy({ model: vendor.model, messages: check.replayMessages });
      assert.equal(decision.action, check.expectedReplayAction, check.id);
    }
  }
});

function liveDisabledReason(): string | undefined {
  if (process.env.WORKFLOW_OPEN_MODEL_PROBES !== "1") return "WORKFLOW_OPEN_MODEL_PROBES is not 1 (probe-gated, unrun)";
  return undefined;
}

function vendorGateReason(vendor: VendorGoldenProbe): string | undefined {
  const disabled = liveDisabledReason();
  if (disabled !== undefined) return disabled;
  if (typeof process.env[vendor.apiKeyEnv] !== "string" || process.env[vendor.apiKeyEnv]?.length === 0) {
    return `${vendor.apiKeyEnv} is not set (probe-gated, unrun)`;
  }
  return undefined;
}

for (const vendor of OPEN_MODEL_GOLDEN_PROBES) {
  const reason = vendorGateReason(vendor);
  test(`live golden probe: ${vendor.vendor} (${reason ?? "running"})`, { skip: reason }, async () => {
    const baseUrl = process.env[vendor.baseUrlEnv] ?? vendor.defaultBaseUrl;
    const parsed = new URL(baseUrl);
    const requestPath = `${parsed.pathname.replace(/\/$/, "")}/chat/completions`;
    const proxy = await createModelUsageProxy({ upstream: parsed.origin, apiKey: process.env[vendor.apiKeyEnv] ?? "" });
    try {
      const toolCheck = vendor.checks.find((check) => check.kind === "strict-schema");
      const tools = toolCheck === undefined
        ? undefined
        : strictifyToolDefinitions([{ type: "function", function: { name: "golden_probe", parameters: vendor.toolSchema } }]);
      const response = await fetch(`${proxy.url}${requestPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: vendor.model,
          messages: [{ role: "user", content: "Reply with the single word: ping." }],
          max_tokens: 16,
          ...(tools === undefined ? {} : { tools, tool_choice: "auto" }),
        }),
      });
      assert.equal(response.ok, true, `${vendor.vendor} live probe returned ${response.status}`);
    } finally {
      await proxy.close();
    }
  });
}
