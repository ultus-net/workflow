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
    messages: Array<{ role: string; content: Array<{ text?: string; cache_control?: { type: string } }> }>;
  };
  assert.equal(marked.system.length, 1);
  assert.equal(marked.system[0]?.cache_control?.type, "ephemeral");
  assert.equal(marked.system[0]?.text, "You are Workflow.");
  assert.equal(marked.tools.length, 2);
  assert.equal(marked.tools[0]?.cache_control, undefined, "only the last tool carries the breakpoint");
  assert.equal(marked.tools[1]?.cache_control?.type, "ephemeral");
  // P13 (issue #292): under the opt-in the pass ALSO marks the previous
  // turn's end (the last message), so the assertion moved from
  // "messages untouched" to the boundary mark.
  assert.equal(marked.messages[0]?.content.at(-1)?.cache_control?.type, "ephemeral", "P13: the previous turn's end carries the boundary breakpoint");
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
  assert.notEqual(result.messages, bare.messages, "P13: the per-turn boundary is marked even without static prefixes");
  assert.equal("system" in result, false, "a body without stable prefixes gains no system block");
});

test("W109: the cacheMarkers opt-in resolves onto the profile only when supplied", () => {
  const opted = modelProfile({ family: "deepseek", model: "deepseek-flash", cacheMarkers: true });
  assert.equal(opted.cacheMarkers, true);
  const plain = modelProfile({ family: "deepseek", model: "deepseek-flash" });
  assert.equal(plain.cacheMarkers, undefined, "absent stays absent — never fabricated");
});

// ---- P14 (issue #293): the cache-marker opt-in gains per-family granularity.
// RED-FIRST: the boolean keeps meaning ALL keyed families (byte-unchanged);
// a map opts in ONLY the families whose entry is true; an omitted family is
// OFF (fail-closed/dark) — never ON-by-default. The marker application
// consults the profile's family. ----

const P14_BODY = { system: "You are Workflow.", tools: [{ name: "read_file" }] };

function isMarked(result: Record<string, unknown>): boolean {
  const system = result.system;
  if (!Array.isArray(system) || system.length === 0) return false;
  const last = system.at(-1);
  return typeof last === "object" && last !== null && (last as { cache_control?: unknown }).cache_control !== undefined;
}

test("P14: a per-family map opts one family in and an omitted family stays dark", () => {
  const optedIn = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: { deepseek: true } });
  assert.equal(isMarked(applyCacheMarkers(optedIn, P14_BODY)), true, "the listed family is marked");
  const omitted = modelProfile({ family: "glm", model: "glm-5.3", wire: "anthropic", cacheMarkers: { deepseek: true } });
  assert.equal(applyCacheMarkers(omitted, P14_BODY), P14_BODY, "a family omitted from the map is OFF — never ON-by-default");
});

test("P14: a per-family map opts one family out and an empty map is all-dark", () => {
  const optedOut = modelProfile({ family: "glm", model: "glm-5.3", wire: "anthropic", cacheMarkers: { glm: false } });
  assert.equal(applyCacheMarkers(optedOut, P14_BODY), P14_BODY, "an explicit false is OFF");
  const empty = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: {} });
  assert.equal(applyCacheMarkers(empty, P14_BODY), P14_BODY, "an empty map means no family is on");
});

test("P14: the boolean opt-in still means ALL keyed families (byte-unchanged)", () => {
  for (const family of ["deepseek", "glm", "kimi"] as const) {
    const profile = modelProfile({ family, model: "m", wire: "anthropic", cacheMarkers: true });
    assert.equal(isMarked(applyCacheMarkers(profile, P14_BODY)), true, `${family} is marked by the boolean opt-in`);
  }
});

test("P14: the default stays dark and the anthropic-wire gate is unchanged under a map", () => {
  const undef = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic" });
  assert.equal(applyCacheMarkers(undef, P14_BODY), P14_BODY, "no option means dark");
  const openaiWire = modelProfile({ family: "deepseek", model: "deepseek-flash", cacheMarkers: { deepseek: true } });
  assert.equal(applyCacheMarkers(openaiWire, P14_BODY), P14_BODY, "the openai wire is never marked, even when the map enables the family");
});

// ---- P13 (issue #292) option B: per-turn boundary marks. Under the SAME
// dark opt-in as the markers-only path, the pass ALSO places one
// `cache_control` breakpoint on the END of the previous turn's last message,
// so the growing conversation prefix becomes cacheable at one-turn reuse
// distance. DEFAULT stays byte-unchanged (no opt-in -> no markers at all).
// The anthropic wire allows a small number of breakpoints per request; option
// B spends exactly ONE on the conversation and holds only the latest stable
// boundary (the prior turn's end, re-derived each turn) — never many prior
// turn ends. ----

const P13_BODY = {
  system: "You are Workflow.",
  tools: [{ name: "read_file" }, { name: "edit_file" }],
  messages: [
    { role: "user", content: "first turn" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "second turn" }, { type: "text", text: "with detail" }] },
  ],
};

function contentBlocks(message: unknown): Array<Record<string, unknown>> {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function countMessageMarkers(result: Record<string, unknown>): number {
  const messages = result.messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block.cache_control !== undefined) count += 1;
    }
  }
  return count;
}

test("P13: the opt-in marks the previous turn's end in addition to the static head", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const marked = applyCacheMarkers(profile, P13_BODY) as {
    system: Array<{ cache_control?: { type: string } }>;
    tools: Array<{ cache_control?: { type: string } }>;
    messages: Array<{ role: string; content: Array<{ text?: string; cache_control?: { type: string } }> }>;
  };
  assert.equal(marked.system.at(-1)?.cache_control?.type, "ephemeral", "the static system head keeps its marker");
  assert.equal(marked.tools.at(-1)?.cache_control?.type, "ephemeral", "the static last tool keeps its marker");
  assert.equal(marked.messages.length, 3);
  assert.equal(contentBlocks(marked.messages[0])[0]?.cache_control, undefined, "prior turns carry no breakpoint");
  assert.equal(contentBlocks(marked.messages[1])[0]?.cache_control, undefined, "prior turns carry no breakpoint");
  const lastBlocks = marked.messages[2]!.content;
  assert.equal(lastBlocks[0]?.cache_control, undefined, "only the last content block is marked");
  assert.equal(lastBlocks.at(-1)?.cache_control?.type, "ephemeral", "the previous turn's end carries the boundary breakpoint");
  assert.equal(lastBlocks.at(-1)?.text, "with detail");
});

test("P13: exactly ONE conversation breakpoint is spent (the wire's small budget)", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const marked = applyCacheMarkers(profile, P13_BODY) as Record<string, unknown>;
  assert.equal(countMessageMarkers(marked), 1, "option B spends exactly one breakpoint on the conversation");
  const systemHead = Array.isArray(marked.system) && (marked.system.at(-1) as { cache_control?: unknown }).cache_control !== undefined ? 1 : 0;
  const toolHead = Array.isArray(marked.tools) && (marked.tools.at(-1) as { cache_control?: unknown }).cache_control !== undefined ? 1 : 0;
  assert.equal(systemHead + toolHead + countMessageMarkers(marked), 3, "static head (2) + one boundary stays inside the wire's few-breakpoint budget");
});

test("P13: a string-content last message is rewritten to a marked text block", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const body = { messages: [{ role: "user", content: "hello" }] };
  const marked = applyCacheMarkers(profile, body) as { messages: Array<{ content: Array<{ type: string; text: string; cache_control?: { type: string } }> }> };
  assert.deepEqual(marked.messages[0]?.content, [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
  assert.equal(body.messages[0]?.content, "hello", "the original body is never mutated");
});

test("P13: a pre-existing boundary marker is preserved, never double-marked", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }, { type: "text", text: "new" }] }] };
  const marked = applyCacheMarkers(profile, body) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  assert.deepEqual(marked.messages[0]?.content[0], body.messages[0]?.content[0], "the earlier pre-existing marker is untouched");
  assert.deepEqual(marked.messages[0]?.content[1], { type: "text", text: "new", cache_control: { type: "ephemeral" } }, "the last block gains exactly one marker");
});

test("P13: no messages, an empty messages array, and the dark default add no conversation breakpoint", () => {
  const opted = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const noMessages = {};
  assert.equal(applyCacheMarkers(opted, noMessages), noMessages, "no messages array adds nothing");
  const empty = { messages: [] as unknown[] };
  assert.equal(applyCacheMarkers(opted, empty), empty, "an empty messages array adds nothing");
  const dark = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic" });
  assert.equal(applyCacheMarkers(dark, P13_BODY), P13_BODY, "DEFAULT byte-unchanged: no opt-in returns the body untouched");
  const openaiWire = modelProfile({ family: "deepseek", model: "deepseek-flash", cacheMarkers: true });
  assert.equal(applyCacheMarkers(openaiWire, P13_BODY), P13_BODY, "the openai wire is never marked, even when opted in");
});

test("P13: a synthetic (host-inserted) final turn still receives the boundary on its last block", () => {
  const profile = modelProfile({ family: "deepseek", model: "deepseek-flash", wire: "anthropic", cacheMarkers: true });
  const synthetic = {
    messages: [
      { role: "user", content: "do it" },
      { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "t1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  };
  const marked = applyCacheMarkers(profile, synthetic) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  assert.equal(marked.messages.at(-1)?.content.at(-1)?.cache_control !== undefined, true, "the boundary tolerates a synthetic inserted tail");
  assert.equal(countMessageMarkers(marked as unknown as Record<string, unknown>), 1, "still exactly one conversation breakpoint");
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
