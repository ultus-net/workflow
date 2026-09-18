import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteEngineEvent } from "../src/integrations/remote-acp/engine.js";
import {
  REMOTE_PERMISSION_OPTIONS,
  availableCommandsUpdate,
  availableModels,
  availableModes,
  currentModeUpdate,
  isSessionIdle,
  permissionReplyFromOutcome,
  permissionToolCall,
  projectReplay,
  projectSessionUpdate,
  sessionConfigOptions,
  toolKind,
  toolStatus,
} from "../src/integrations/remote-acp/projection.js";

const event = (type: string, properties: Record<string, unknown>): RemoteEngineEvent => ({ type, properties });

test("permission options mirror the native allow once/always + reject set", () => {
  assert.deepEqual(REMOTE_PERMISSION_OPTIONS, [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ]);
});

test("permission reply maps selected once/always and rejects everything else", () => {
  assert.equal(permissionReplyFromOutcome({ outcome: "selected", optionId: "once" }), "once");
  assert.equal(permissionReplyFromOutcome({ outcome: "selected", optionId: "always" }), "always");
  assert.equal(permissionReplyFromOutcome({ outcome: "selected", optionId: "reject" }), "reject");
  assert.equal(permissionReplyFromOutcome({ outcome: "cancelled" }), "reject");
  assert.equal(permissionReplyFromOutcome({ outcome: "selected", optionId: "unknown" }), "reject");
  assert.equal(permissionReplyFromOutcome(undefined), "reject");
});

test("permission tool call carries the call id, kind, locations and raw input", () => {
  const toolCall = permissionToolCall({
    id: "per_1",
    sessionID: "ses_1",
    action: "edit",
    resources: ["src/a.ts"],
    tool: { callID: "call_1" },
    metadata: { filepath: "src/a.ts", diff: "@@" },
  });
  assert.equal(toolCall.toolCallId, "call_1");
  assert.equal(toolCall.kind, "edit");
  assert.equal(toolCall.title, "src/a.ts");
  assert.deepEqual(toolCall.locations, [{ path: "src/a.ts" }]);
  assert.deepEqual(toolCall.rawInput, { filepath: "src/a.ts", diff: "@@" });
});

test("permission tool call falls back to the request id when no tool call id is present", () => {
  const toolCall = permissionToolCall({ id: "per_2", sessionID: "ses_1", action: "bash", resources: ["npm test"], metadata: { command: "npm test" } });
  assert.equal(toolCall.toolCallId, "per_2");
  assert.equal(toolCall.kind, "execute");
  assert.equal(toolCall.title, "npm test");
});

test("text and reasoning part updates project to ACP message chunks", () => {
  const text = projectSessionUpdate(event("message.part.updated", {
    part: { type: "text", sessionID: "ses_1", messageID: "msg_1", text: "hello" },
  }));
  assert.deepEqual(text, {
    sessionId: "ses_1",
    update: { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "hello" } },
  });

  const thought = projectSessionUpdate(event("message.part.updated", {
    part: { type: "reasoning", sessionID: "ses_1", id: "part_1", text: "thinking" },
  }));
  assert.deepEqual(thought, {
    sessionId: "ses_1",
    update: { sessionUpdate: "agent_thought_chunk", messageId: "part_1", content: { type: "text", text: "thinking" } },
  });
});

test("text deltas project to ACP message chunks and ignore non-text fields", () => {
  const projected = projectSessionUpdate(event("message.part.delta", {
    sessionID: "ses_1", partID: "part_1", field: "text", delta: "wor",
  }));
  assert.deepEqual(projected, {
    sessionId: "ses_1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wor" } },
  });
  assert.equal(projectSessionUpdate(event("message.part.delta", { sessionID: "ses_1", field: "reasoning", delta: "x" })), undefined);
});

test("tool part updates project pending/running/completed/error states", () => {
  const pending = projectSessionUpdate(event("message.part.updated", {
    part: { type: "tool", sessionID: "ses_1", callID: "call_1", tool: "bash", state: { status: "pending", input: { command: "ls" } } },
  }));
  assert.equal((pending?.update as { sessionUpdate: string }).sessionUpdate, "tool_call");
  assert.equal((pending?.update as { kind: string }).kind, "execute");

  const running = projectSessionUpdate(event("message.part.updated", {
    part: { type: "tool", sessionID: "ses_1", callID: "call_1", tool: "edit", state: { status: "running", title: "src/a.ts", output: "ok" } },
  }));
  assert.equal((running?.update as { sessionUpdate: string }).sessionUpdate, "tool_call_update");
  assert.equal((running?.update as { status: string }).status, "in_progress");
  assert.deepEqual((running?.update as { content: unknown }).content, [{ type: "content", content: { type: "text", text: "ok" } }]);

  const failed = projectSessionUpdate(event("message.part.updated", {
    part: { type: "tool", sessionID: "ses_1", callID: "call_1", tool: "bash", state: { status: "error" } },
  }));
  assert.equal((failed?.update as { status: string }).status, "failed");
});

test("unmapped events project to nothing", () => {
  assert.equal(projectSessionUpdate(event("session.status", { sessionID: "ses_1", status: { type: "idle" } })), undefined);
  assert.equal(projectSessionUpdate(event("message.part.updated", { part: { type: "file" } })), undefined);
  assert.equal(projectSessionUpdate(event("unknown.event", {})), undefined);
});

test("idle detection matches only the idle status for the session", () => {
  assert.equal(isSessionIdle(event("session.status", { sessionID: "ses_1", status: { type: "idle" } }), "ses_1"), true);
  assert.equal(isSessionIdle(event("session.status", { sessionID: "ses_1", status: { type: "busy" } }), "ses_1"), false);
  assert.equal(isSessionIdle(event("session.status", { sessionID: "ses_2", status: { type: "idle" } }), "ses_1"), false);
  assert.equal(isSessionIdle(event("message.part.updated", {}), "ses_1"), false);
});

test("tool kinds and statuses map conservatively", () => {
  assert.equal(toolKind("read"), "read");
  assert.equal(toolKind("edit"), "edit");
  assert.equal(toolKind("bash"), "execute");
  assert.equal(toolKind("webfetch"), "fetch");
  assert.equal(toolKind("task"), "think");
  assert.equal(toolKind("mystery"), "other");
  assert.equal(toolKind(undefined), "other");
  assert.equal(toolStatus("pending"), "pending");
  assert.equal(toolStatus("running"), "in_progress");
  assert.equal(toolStatus("completed"), "completed");
  assert.equal(toolStatus("error"), "failed");
  assert.equal(toolStatus(undefined), "in_progress");
});

test("projectReplay replays assistant parts and skips user messages", () => {
  const updates = projectReplay([
    { info: { role: "user" }, parts: [{ type: "text", sessionID: "ses_1", text: "skip" }] },
    { info: { role: "assistant" }, parts: [
      { type: "reasoning", sessionID: "ses_1", id: "p1", text: "think" },
      { type: "text", sessionID: "ses_1", text: "answer" },
      { type: "tool", sessionID: "ses_1", callID: "c1", tool: "bash", state: { status: "completed" } },
    ] },
  ]);
  assert.deepEqual(updates.map((entry) => (entry.update as { sessionUpdate: string }).sessionUpdate), [
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call_update",
  ]);
});

test("availableModes excludes subagents and hidden agents", () => {
  assert.deepEqual(
    availableModes([
      { id: "build", name: "Build", mode: "primary" },
      { id: "explore", mode: "subagent" },
      { id: "secret", mode: "primary", hidden: true },
      { id: "plan", mode: "all", description: "Plan work" },
    ]),
    [
      { id: "build", name: "Build" },
      { id: "plan", name: "plan", description: "Plan work" },
    ],
  );
});

test("availableModels flattens providers into provider/model entries", () => {
  assert.deepEqual(
    availableModels([
      { id: "anthropic", name: "Anthropic", models: [{ id: "claude", name: "Claude", variants: [] }, { id: "haiku", variants: [] }] },
    ]),
    [
      { modelId: "anthropic/claude", name: "Anthropic: Claude", variants: [] },
      { modelId: "anthropic/haiku", name: "anthropic/haiku", variants: [] },
    ],
  );
});

test("sessionConfigOptions builds mode, model, and effort selects with current values", () => {
  const options = sessionConfigOptions({
    modes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }],
    models: [{ modelId: "anthropic/claude", name: "Claude", variants: [{ id: "high", name: "High" }, { id: "low" }] }],
    currentModeId: "plan",
  });
  assert.deepEqual(options, [
    { id: "mode", name: "Mode", type: "select", currentValue: "plan", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
    { id: "model", name: "Model", type: "select", currentValue: "anthropic/claude", options: [{ value: "anthropic/claude", name: "Claude" }] },
    { id: "effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }, { value: "low", name: "low" }] },
  ]);
  const withVariant = sessionConfigOptions({
    modes: [],
    models: [{ modelId: "anthropic/claude", name: "Claude", variants: [{ id: "high" }, { id: "low" }] }],
    currentVariantId: "low",
  });
  assert.equal(withVariant.find((option) => option.id === "effort")?.currentValue, "low");
  assert.deepEqual(sessionConfigOptions({ modes: [], models: [] }), []);
});

test("availableCommandsUpdate and currentModeUpdate build the notification shapes", () => {
  assert.deepEqual(availableCommandsUpdate("ses_1", [{ name: "test", description: "Run tests" }, { name: "init" }]), {
    sessionId: "ses_1",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "test", description: "Run tests" }, { name: "init" }],
    },
  });
  assert.deepEqual(currentModeUpdate("ses_1", "plan"), {
    sessionId: "ses_1",
    update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
  });
});
