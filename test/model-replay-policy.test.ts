import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectStrippedReplay,
  detectSyntheticToolCallTurns,
  enforceReplayPolicy,
  maySynthesizeToolCallTurn,
  replayPolicyForModel,
} from "../src/integrations/model-replay-policy.js";

const KIMI_PRESERVED = [
  { role: "system", content: "sys" },
  { role: "user", content: "edit the file" },
  {
    role: "assistant",
    content: null,
    reasoning_content: "I should read the file first.",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "call_1", content: "file body" },
  {
    role: "assistant",
    content: null,
    reasoning_content: "Now I can edit it.",
    tool_calls: [{ id: "call_2", type: "function", function: { name: "edit", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "call_2", content: "ok" },
];

test("K3 preserved-thinking replay fixture passes the policy", () => {
  assert.equal(replayPolicyForModel("kimi-k3").assistantReplay, "preserve-verbatim");
  assert.deepEqual(detectStrippedReplay(KIMI_PRESERVED), []);
  assert.equal(enforceReplayPolicy({ model: "kimi-k3", messages: KIMI_PRESERVED }).action, "allow");
});

test("K3 stripped replay fixture is detected and rejected", () => {
  // The reasoning_content was stripped from the assistant turns and the
  // assistant tool-call turn was summarized away, leaving a bare tool result.
  const stripped = [
    { role: "system", content: "sys" },
    { role: "user", content: "edit the file" },
    { role: "assistant", content: "I'll read the file." },
    { role: "tool", tool_call_id: "call_1", content: "file body" },
  ];
  const violations = detectStrippedReplay(stripped);
  assert.equal(violations.some((violation) => violation.code === "stripped-tool-calls"), true);

  const decision = enforceReplayPolicy({ model: "kimi-k3", messages: stripped });
  assert.equal(decision.action, "reject");
  if (decision.action === "reject") {
    assert.equal(decision.violations.length > 0, true);
    assert.match(decision.reason, /reasoning_content \+ tool_calls/);
  }
});

test("K3 assistant tool-call turn missing reasoning_content is detected", () => {
  const noReasoning = [
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "edit" } }] },
    { role: "tool", tool_call_id: "call_9", content: "ok" },
  ];
  const violations = detectStrippedReplay(noReasoning);
  assert.deepEqual(
    violations.map((violation) => violation.code),
    ["stripped-reasoning-content"],
  );
});

test("DeepSeek synthesized mid-conversation tool-call turn routes to the Anthropic path", () => {
  // A tool result inserted with no preceding assistant tool-call turn is the
  // Chat-Completion insertion shape DeepSeek forbids.
  const inserted = [
    { role: "system", content: "sys" },
    { role: "user", content: "run the tool" },
    { role: "tool", tool_call_id: "call_seed", content: "seeded result" },
  ];
  assert.equal(detectSyntheticToolCallTurns(inserted).length > 0, true);
  const decision = enforceReplayPolicy({ model: "deepseek-chat", messages: inserted });
  assert.equal(decision.action, "route-anthropic");
  if (decision.action === "route-anthropic") {
    assert.match(decision.reason, /Anthropic-format/);
  }
});

test("DeepSeek legitimate tool loop through Chat Completion is allowed", () => {
  const loop = [
    { role: "user", content: "edit the file" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read" } }] },
    { role: "tool", tool_call_id: "call_1", content: "body" },
  ];
  assert.deepEqual(detectSyntheticToolCallTurns(loop), []);
  assert.equal(enforceReplayPolicy({ model: "deepseek-chat", messages: loop }).action, "allow");
});

test("DeepSeek dangling tool-call turn with no results is detected", () => {
  const dangling = [
    { role: "user", content: "edit" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "edit" } }] },
    { role: "user", content: "hello?" },
  ];
  assert.equal(detectSyntheticToolCallTurns(dangling).length > 0, true);
});

test("GLM uses standard replay and is not subject to the K3/DeepSeek checks", () => {
  const policy = replayPolicyForModel("glm-5.3");
  assert.equal(policy.assistantReplay, "standard");
  assert.equal(policy.syntheticToolCallTransport, "chat-completions");
  assert.equal(enforceReplayPolicy({ model: "glm-5.3", messages: [{ role: "tool", content: "x" }] }).action, "allow");
});

test("unknown models carry no vendor contract", () => {
  assert.equal(replayPolicyForModel("gpt-5").family, "unknown");
  assert.equal(enforceReplayPolicy({ model: "gpt-5", messages: [{ role: "tool", content: "x" }] }).action, "allow");
});

test("synthetic tool-call transport is only Anthropic for DeepSeek", () => {
  assert.equal(maySynthesizeToolCallTurn("deepseek", "chat-completions"), false);
  assert.equal(maySynthesizeToolCallTurn("deepseek", "anthropic-messages"), true);
  assert.equal(maySynthesizeToolCallTurn("kimi-k3", "chat-completions"), true);
  assert.equal(maySynthesizeToolCallTurn("glm", "chat-completions"), true);
});
