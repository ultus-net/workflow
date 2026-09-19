import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VENDOR_DEFAULTS,
  isShapeableForFamily,
  modelProfile,
  reasoningEffortFor,
  shapeRequestBody,
} from "../src/integrations/model-profile.js";

/**
 * W070a: the pure per-vendor request-shaping contract. The hard invariant is
 * that GLM/K3 never receive `thinking.type: "disabled"` (GLM-5.3 rejects it;
 * K3 does not accept the field) and every effort field is a verified value.
 */

test("task-class effort defaults follow vendor guidance", () => {
  assert.equal(reasoningEffortFor("deepseek", "coding"), "high", "DeepSeek's coding guide uses high");
  assert.equal(reasoningEffortFor("glm", "coding"), "max", "GLM recommends max for complex coding");
  assert.equal(reasoningEffortFor("kimi", "coding"), "max");
  assert.equal(reasoningEffortFor("deepseek", "general"), "high");
  assert.equal(reasoningEffortFor("glm", "general"), "high");
  assert.equal(reasoningEffortFor("kimi", "general"), "high");
  for (const family of ["deepseek", "glm", "kimi"] as const) {
    assert.equal(reasoningEffortFor(family, "batch"), "low", `${family} batch work runs at low effort`);
  }
});

test("modelProfile resolves family defaults and honors overrides", () => {
  const profile = modelProfile({ family: "glm", model: "glm-5.3-flash", taskClass: "coding" });
  assert.equal(profile.endpoint, VENDOR_DEFAULTS.glm.endpoint);
  assert.equal(profile.wire, "openai");
  assert.equal(profile.thinking, "always-on");
  assert.equal(profile.defaultEffort, "max");
  assert.equal(profile.reasoningEffort, "max");

  const overridden = modelProfile({ family: "deepseek", model: "deepseek-flash", taskClass: "coding", reasoningEffort: "max" });
  assert.equal(overridden.reasoningEffort, "max");
});

test("GLM shaping forces thinking enabled and never emits disabled", () => {
  const profile = modelProfile({ family: "glm", model: "glm-5.3" });
  const shaped = shapeRequestBody(profile, { model: "glm-5.3", thinking: { type: "disabled" }, reasoning_effort: "low" });
  assert.deepEqual(shaped.thinking, { type: "enabled" });
  assert.equal(shaped.reasoning_effort, "max");
  assert.ok(!JSON.stringify(shaped).includes("\"disabled\""), "no disabled thinking marker may survive shaping");
  assert.equal(isShapeableForFamily("glm", shaped), true);
});

test("Kimi K3 shaping drops the GPT-era thinking field and uses top-level reasoning_effort", () => {
  const profile = modelProfile({ family: "kimi", model: "kimi-k3" });
  const shaped = shapeRequestBody(profile, {
    model: "kimi-k3",
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal("thinking" in shaped, false, "K3 has no thinking field");
  assert.equal(shaped.reasoning_effort, "max");
  assert.ok(!JSON.stringify(shaped).includes("\"disabled\""));
  assert.equal(isShapeableForFamily("kimi", shaped), true);
});

test("DeepSeek shaping opts into thinking with a valid effort", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", taskClass: "general" });
  const shaped = shapeRequestBody(profile, { model: "deepseek-flash", messages: [] });
  assert.deepEqual(shaped.thinking, { type: "enabled" });
  assert.equal(shaped.reasoning_effort, "high");
  assert.equal(isShapeableForFamily("deepseek", shaped), true);
  assert.equal(isShapeableForFamily("deepseek", { thinking: { type: "disabled" } }), true, "DeepSeek genuinely supports disabled");
});

test("vendor sampling defaults apply only when the body omits them", () => {
  const profile = modelProfile({ family: "glm", model: "glm-5.3" });
  const shaped = shapeRequestBody(profile, { model: "glm-5.3", temperature: 0.2 });
  assert.equal(shaped.temperature, 0.2, "caller temperature is preserved");
  assert.equal(shaped.top_p, 0.95, "GLM top_p default fills in");
});

test("shaping never mutates its input", () => {
  const profile = modelProfile({ family: "glm", model: "glm-5.3" });
  const input: Record<string, unknown> = { model: "glm-5.3", thinking: { type: "disabled" } };
  const snapshot = JSON.stringify(input);
  shapeRequestBody(profile, input);
  assert.equal(JSON.stringify(input), snapshot);
});

test("isShapeableForFamily rejects disabled thinking for always-on families", () => {
  assert.equal(isShapeableForFamily("glm", { thinking: { type: "disabled" } }), false);
  assert.equal(isShapeableForFamily("kimi", { thinking: { type: "disabled" } }), false);
  assert.equal(isShapeableForFamily("glm", { reasoning_effort: "high" }), true);
  assert.equal(isShapeableForFamily("kimi", { reasoning_effort: "ultra" }), false, "unverified effort values are rejected");
});
