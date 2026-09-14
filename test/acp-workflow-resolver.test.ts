import assert from "node:assert/strict";
import test from "node:test";

import { AcpHostAdapter, taskId, type PolicyDecision, type ProposedToolAction } from "../src/index.js";
import { createWorkflowAcpPermissionResolver } from "../src/adapters/acp-workflow-resolver.js";
import type { AcpPermissionRequestParams } from "../src/adapters/acp-permission.js";

const request: AcpPermissionRequestParams = {
  sessionId: "agent-session-1",
  toolCall: {
    toolCallId: "tool-1",
    title: "Write file",
    kind: "edit",
    rawInput: { path: "src/a.ts" },
    locations: [{ path: "src/a.ts" }],
  },
  options: [
    { optionId: "allow-1", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-1", name: "Reject once", kind: "reject_once" },
  ],
};

function resolverWith(action: (action: ProposedToolAction) => Promise<PolicyDecision> | PolicyDecision) {
  return createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation: {
      sessionId: "workflow-session-1",
      agentSessionId: "agent-session-1",
      taskId: taskId("TASK-1"),
      toolName: "write_file",
      capability: "mutation",
    },
    authorize: action,
  });
}

test("Workflow ACP resolver correlates and authorizes through the existing adapter path", async () => {
  const seen: ProposedToolAction[] = [];
  const resolver = resolverWith((action) => {
    seen.push(action);
    return { kind: "allow" };
  });

  assert.deepEqual(await resolver(request), { kind: "allow" });
  assert.deepEqual(seen, [{
    sessionId: "workflow-session-1",
    taskId: "TASK-1",
    tool: "write_file",
    capability: "mutation",
    requiredCapabilities: ["mutation"],
    mutating: true,
    subjects: ["src/a.ts"],
    input: { path: "src/a.ts" },
  }]);
});

test("Workflow ACP resolver rejects a permission request from the wrong wire session before authorization", async () => {
  let authorized = false;
  const resolver = resolverWith(() => {
    authorized = true;
    return { kind: "allow" };
  });

  await assert.rejects(
    () => resolver({ ...request, sessionId: "other-agent-session" }),
    /ACP permission session mismatch/,
  );
  assert.equal(authorized, false);
});

test("Workflow ACP resolver conservatively treats unknown tool kinds as mutating", async () => {
  const seen: ProposedToolAction[] = [];
  const resolver = resolverWith((action) => {
    seen.push(action);
    return { kind: "allow" };
  });
  const unknownKind = { ...request, toolCall: { ...request.toolCall, kind: "custom-extension" } };

  assert.deepEqual(await resolver(unknownKind), { kind: "allow" });
  assert.equal(seen[0]?.mutating, true);
  assert.deepEqual(seen[0]?.requiredCapabilities, ["mutation"]);
});

test("Workflow ACP resolver preserves explicit read capability without downgrading it", async () => {
  const seen: ProposedToolAction[] = [];
  const resolver = createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation: {
      sessionId: "workflow-session-1",
      agentSessionId: "agent-session-1",
      taskId: taskId("TASK-1"),
      toolName: "read_file",
      capability: "read",
    },
    authorize(action) {
      seen.push(action);
      return { kind: "allow" };
    },
  });
  const readKind = { ...request, toolCall: { ...request.toolCall, kind: "read" } };

  assert.deepEqual(await resolver(readKind), { kind: "allow" });
  assert.equal(seen[0]?.mutating, false);
  assert.deepEqual(seen[0]?.requiredCapabilities, ["read"]);
});

test("Workflow ACP resolver propagates authorization callback failure fail-closed", async () => {
  const resolver = resolverWith(() => {
    throw new Error("authorization unavailable");
  });

  await assert.rejects(() => resolver(request), /authorization unavailable/);
});

test("Workflow ACP resolver omits absent optional fields instead of passing undefined", async () => {
  const seen: ProposedToolAction[] = [];
  const resolver = createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation: {
      sessionId: "workflow-session-1",
      agentSessionId: "agent-session-1",
      taskId: taskId("TASK-1"),
      toolName: "unknown_tool",
    },
    authorize(action) {
      seen.push(action);
      return { kind: "allow" };
    },
  });
  const minimal: AcpPermissionRequestParams = {
    ...request,
    toolCall: { toolCallId: "tool-min", title: "Unknown", kind: "read", locations: [] },
  };

  assert.deepEqual(await resolver(minimal), { kind: "allow" });
  assert.deepEqual(seen[0], {
    sessionId: "workflow-session-1",
    taskId: "TASK-1",
    tool: "unknown_tool",
    capability: "read",
    requiredCapabilities: ["read"],
    mutating: true,
    subjects: [],
    input: undefined,
  });
});

test("Workflow ACP resolver fails closed when a mutation-capability proposal has no usable subject", async () => {
  const resolver = createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation: {
      sessionId: "workflow-session-1",
      agentSessionId: "agent-session-1",
      taskId: taskId("TASK-1"),
      toolName: "unknown_tool",
    },
    authorize: () => ({ kind: "allow" }),
  });
  const minimal: AcpPermissionRequestParams = {
    ...request,
    toolCall: { toolCallId: "tool-min", title: "Unknown", locations: [] },
  };

  await assert.rejects(() => resolver(minimal), /invalid ACP tool subject/);
});

test("Workflow ACP resolver preserves adapter denial as a permission denial", async () => {
  const resolver = resolverWith((): PolicyDecision => ({ kind: "deny", code: "BLOCKED", reason: "policy denied" }));

  assert.deepEqual(await resolver(request), { kind: "deny", reason: "policy denied" });
});

test("Workflow ACP resolver fails closed on malformed permission metadata", async () => {
  const resolver = resolverWith(() => ({ kind: "allow" }));

  await assert.rejects(
    () => resolver({ ...request, toolCall: { ...request.toolCall, locations: [{}] } }),
    /invalid ACP tool location/,
  );
});
