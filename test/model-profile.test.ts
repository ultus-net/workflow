import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VENDOR_DEFAULTS,
  applyCacheMarkers,
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

// ---- W109 (W098 c2): the cache-control marker injection — the stable
// composition-time prefixes (system block, last tool) get the anthropic
// ephemeral marker when the pool opts in; the per-turn message lane is
// untouched, and everything is opt-in + wire-gated. ----

test("W109: applyCacheMarkers marks the stable composition-time prefixes on the anthropic wire", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const body = {
    system: "You are Workflow.",
    tools: [{ name: "read_file" }, { name: "edit_file" }],
    messages: [{ role: "user", content: "hello" }],
  };
  const marked = applyCacheMarkers(profile, body) as {
    system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    tools: Array<{ name: string; cache_control?: { type: string } }>;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(marked.system.length, 1);
  assert.equal(marked.system[0]?.cache_control?.type, "ephemeral");
  assert.equal(marked.system[0]?.text, "You are Workflow.");
  assert.equal(marked.tools.length, 2);
  assert.equal(marked.tools[0]?.cache_control, undefined, "only the last tool carries the breakpoint");
  assert.equal(marked.tools[1]?.cache_control?.type, "ephemeral");
  assert.deepEqual(marked.messages, body.messages, "messages are the per-turn lane — untouched by the marker pass");
  assert.equal(body.system, "You are Workflow.", "the original body is never mutated");
});

test("W109: array-form system blocks get the marker on the last block only", () => {
  const profile = modelProfile({ family: "glm", model: "glm-5.3", wire: "anthropic", cacheMarkers: true });
  const body = {
    system: [
      { type: "text", text: "part one" },
      { type: "text", text: "part two" },
    ],
  };
  const marked = applyCacheMarkers(profile, body) as { system: Array<{ text: string; cache_control?: { type: string } }> };
  assert.equal(marked.system[0]?.cache_control, undefined);
  assert.equal(marked.system[1]?.cache_control?.type, "ephemeral");
  assert.equal(marked.system[1]?.text, "part two");
});

test("W109: an already-marked prefix block is preserved, never double-marked", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const body = {
    system: [
      { type: "text", text: "part one", cache_control: { type: "ephemeral" } },
      { type: "text", text: "part two" },
    ],
  };
  const marked = applyCacheMarkers(profile, body) as { system: Array<{ text: string; cache_control?: { type: string } }> };
  assert.equal(marked.system[0]?.cache_control?.type, "ephemeral", "the pre-existing marker survives untouched");
  assert.equal(marked.system[1]?.cache_control?.type, "ephemeral", "the marker moves to the last block");
  // Only the last block changes: the pass never stacks a second marker on
  // an already-marked block.
  assert.deepEqual(marked.system[0], body.system[0]);
});

test("W109: the marker pass is opt-in and wire-gated — everything else passes through untouched", () => {
  const body = { system: "You are Workflow.", tools: [{ name: "read_file" }] };
  const unmarked = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic" });
  assert.equal(applyCacheMarkers(unmarked, body), body, "no opt-in returns the body untouched — absent stays absent");
  const openaiWire = modelProfile({ family: "deepseek", model: "deepseek-flash", cacheMarkers: true });
  assert.equal(applyCacheMarkers(openaiWire, body), body, "the openai wire auto-caches upstream; the pass is anthropic-only");
  const opted = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const bare = { messages: [{ role: "user", content: "hi" }] };
  const result = applyCacheMarkers(opted, bare);
  assert.equal(result.messages, bare.messages);
  assert.equal("system" in result, false, "a body without stable prefixes gains nothing");
});

test("W109: the cacheMarkers opt-in resolves onto the profile only when supplied", () => {
  const opted = modelProfile({ family: "deepseek", model: "deepseek-flash", cacheMarkers: true });
  assert.equal(opted.cacheMarkers, true);
  const plain = modelProfile({ family: "deepseek", model: "deepseek-flash" });
  assert.equal(plain.cacheMarkers, undefined, "absent stays absent — never fabricated");
});

// W109 (frontier round 1 P1): the glm/kimi anthropic-wire shapes are UNPROBED
// — the openai-wire fields are not valid Messages-schema fields, so the
// shaping emits only verified shared fields on that wire (fail-closed: no
// invented shape).
test("W109: glm/kimi anthropic-wire shaping emits no openai-wire reasoning fields", () => {
  const glm = modelProfile({ family: "glm", model: "glm-5.3", wire: "anthropic", taskClass: "coding" });
  const glmShaped = shapeRequestBody(glm, { messages: [] }) as Record<string, unknown>;
  assert.equal("thinking" in glmShaped, false, "thinking.enabled is not a Messages field for GLM");
  assert.equal("reasoning_effort" in glmShaped, false, "reasoning_effort is not a Messages field");
  assert.equal(glmShaped.temperature, 1, "the shared sampling default survives on the anthropic wire");
  const kimi = modelProfile({ family: "kimi", model: "kimi-k3", wire: "anthropic", taskClass: "coding" });
  const kimiShaped = shapeRequestBody(kimi, { messages: [] }) as Record<string, unknown>;
  assert.equal("thinking" in kimiShaped, false);
  assert.equal("reasoning_effort" in kimiShaped, false);
  // The openai wire keeps its verified shapes.
  assert.deepEqual(shapeRequestBody(modelProfile({ family: "kimi", model: "kimi-k3", taskClass: "coding" }), { messages: [] }).reasoning_effort, "max");
  assert.deepEqual(shapeRequestBody(modelProfile({ family: "glm", model: "glm-5.3", taskClass: "coding" }), { messages: [] }).reasoning_effort, "max");
  // Review round 1 P2-1: a CALLER-SUPPLIED thinking field is scrubbed on
  // the anthropic wire too — the module invariant (GLM/K3 never carry
  // thinking.type:"disabled") holds on every wire, and the nested omits
  // mean the second spread cannot re-add what the first removed.
  const hostile = { messages: [], thinking: { type: "disabled" }, reasoning_effort: "ultra" };
  const glmScrubbed = shapeRequestBody(glm, hostile) as Record<string, unknown>;
  assert.equal("thinking" in glmScrubbed, false);
  assert.equal("reasoning_effort" in glmScrubbed, false);
  const kimiScrubbed = shapeRequestBody(kimi, hostile) as Record<string, unknown>;
  assert.equal("thinking" in kimiScrubbed, false);
  assert.equal("reasoning_effort" in kimiScrubbed, false);
});
