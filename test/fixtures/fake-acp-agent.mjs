import { setTimeout } from "node:timers";

const mode = process.argv[2] ?? "happy";
let cancelled = false;
let activePromptId;
let permissionRequestId = 9001;

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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
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
        configOptions: [{ id: "auto_approve", name: "Auto-approve", options: [{ id: "true" }, { id: "false" }] }],
      },
    });
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
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    cancelled = false;
    activePromptId = message.id;
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
