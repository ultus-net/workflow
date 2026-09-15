import { setTimeout } from "node:timers";

const mode = process.argv[2] ?? "happy";
let cancelled = false;
let activePromptId;
let permissionRequestId = 9001;
let configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-k2",
    options: [
      { value: "kimi-k2", name: "Kimi K2" },
      { value: "moonshot-v1", name: "Moonshot v1" },
    ],
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handlePermissionResponse(message) {
  const outcome = message.result?.outcome;
  const optionId = outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
  const failClosed = mode === "permission-no-reject" && outcome?.outcome === "cancelled";
  send({
    jsonrpc: "2.0",
    id: activePromptId,
    result: failClosed
      ? { stopReason: "cancelled", failClosedReason: "no_reject_option" }
      : { stopReason: "end_turn", permissionOutcome: optionId },
  });
}

function handleMessage(message) {
  if (message.id === permissionRequestId && message.result) {
    handlePermissionResponse(message);
    return;
  }
  if (message.method === "initialize") {
    const supportsBooleanConfig = message.params?.clientCapabilities?.session?.configOptions?.boolean !== undefined;
    send({
      jsonrpc: mode === "invalid-jsonrpc" ? "1.0" : "2.0",
      id: message.id,
      result: {
        protocolVersion: mode === "require-boolean-capability" && !supportsBooleanConfig ? 0 : 1,
        agentCapabilities: { loadSession: mode !== "no-load" },
        ...(mode === "no-agent-info" ? {} : { agentInfo: { name: "fake-acp-agent", version: "0.0.0" } }),
      },
    });
  } else if (message.method === "session/new") {
    // Advertise G2's configOptions surface the way Cline does (modes/models/
    // option lists), exercising the client capture path.
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "fake-session-1",
        availableModes: ["plan", "act"],
        availableModels: ["kimi-k2", "moonshot-v1"],
        configOptions,
      },
    });
  } else if (message.method === "session/set_config_option") {
    // Mirror the ACP schema: boolean values must carry type:"boolean".
    if (typeof message.params.value === "boolean" && message.params.type !== "boolean") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params: boolean value requires type boolean" } });
      return;
    }
    configOptions = configOptions.map((option) => option.id === message.params.configId
      ? { ...option, currentValue: message.params.value }
      : option);
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
  } else if (message.method === "session/load") {
    // Replay history before resolving, mirroring the spec's load contract.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier user turn" } },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier agent turn" } },
      },
    });
    send({ jsonrpc: "2.0", id: message.id, result: mode === "load-config" ? { configOptions } : null });
  } else if (message.method === "session/prompt") {
    cancelled = false;
    activePromptId = message.id;
    if (mode === "batch2") {
      const sessionId = message.params.sessionId;
      const update = (updateBody) => send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: updateBody },
      });
      update({ sessionUpdate: "session_info_update", title: "Fixture batch2 title" });
      update({
        sessionUpdate: "plan",
        entries: [
          { id: "p1", status: "pending", content: "Inspect the workspace" },
          { id: "p2", status: "pending", content: "Apply the edit" },
        ],
      });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reasoning about " } });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the fixture" } });
      update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-batch2",
        title: "Read workspace",
        kind: "read",
        status: "pending",
        rawInput: { path: "src/index.ts" },
        locations: [{ path: "src/index.ts" }],
      });
      update({ sessionUpdate: "tool_call_update", toolCallId: "tool-batch2", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "tool-batch2", status: "completed", rawOutput: [{ result: "file contents" }] });
      update({ sessionUpdate: "plan", entries: [
        { id: "p1", status: "completed", content: "Inspect the workspace" },
        { id: "p2", status: "in_progress", content: "Apply the edit" },
      ] });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (mode === "config-update") {
      configOptions = configOptions.map((option) => option.id === "model" ? { ...option, currentValue: "moonshot-v1" } : option);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions },
        },
      });
    }
    if (mode === "invalid-update") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: null } });
      return;
    }
    if (mode === "invalid-config-update") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: message.params.sessionId, update: { sessionUpdate: "config_option_update" } },
      });
      return;
    }
    if (mode === "permission" || mode === "permission-no-reject" || mode === "permission-string-id") {
      const options = mode === "permission-no-reject"
        ? [{ optionId: "allow-1", name: "Allow once", kind: "allow_once" }]
        : [
            { optionId: "allow-1", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-1", name: "Reject once", kind: "reject_once" },
          ];
      permissionRequestId = mode === "permission-string-id" ? "perm-9001" : 9001;
      send({
        jsonrpc: "2.0",
        id: permissionRequestId,
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: {
            toolCallId: "tool-permission-1",
            // Real Cline permission requests carry the tool name as the title
            // (e.g. replace_in_file), so exercise that shape here.
            title: "replace_in_file",
            kind: "edit",
            rawInput: { path: "target.txt" },
            locations: [{ path: "target.txt" }],
          },
          options,
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } },
      },
    });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read repo" },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
    }, 25);
  } else if (message.method === "session/cancel") {
    cancelled = true;
  }
}

if (mode === "malformed") {
  process.stdout.write('{"jsonrpc":"2.0","id":1\n');
} else if (mode === "exit") {
  process.exit(1);
} else {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      handleMessage(JSON.parse(line));
    }
  });
}
