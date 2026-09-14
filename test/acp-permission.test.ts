import assert from "node:assert/strict";
import test from "node:test";

import { taskId } from "../src/index.js";
import {
  acpPermissionDenial,
  correlateAcpPermissionRequest,
  type AcpPermissionRequestParams,
} from "../src/adapters/acp-permission.js";

const request: AcpPermissionRequestParams = {
  sessionId: "agent-session-1",
  toolCall: {
    toolCallId: "tool-1",
    title: "Write src/a.ts",
    kind: "edit",
    rawInput: { path: "src/a.ts" },
    locations: [{ path: "src/a.ts" }],
  },
  options: [
    { optionId: "allow-1", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-1", name: "Reject once", kind: "reject_once" },
  ],
};

test("ACP permission normalization correlates Workflow task context without trusting wire task fields", () => {
  const correlated = correlateAcpPermissionRequest(request, {
    sessionId: "workflow-session-1",
    agentSessionId: "agent-session-1",
    taskId: taskId("TASK-1"),
    toolName: "write_file",
    capability: "mutation",
  });

  assert.deepEqual(correlated, {
    sessionId: "workflow-session-1",
    taskId: "TASK-1",
    toolCall: {
      name: "write_file",
      kind: "edit",
      capability: "mutation",
      rawInput: { path: "src/a.ts" },
      locations: [{ path: "src/a.ts" }],
    },
  });
});

test("ACP permission denial selects the agent-provided rejecting option", () => {
  assert.deepEqual(acpPermissionDenial(request), {
    outcome: "selected",
    optionId: "reject-1",
  });
});

test("ACP permission denial fails closed when no rejecting option exists", () => {
  const withoutReject: AcpPermissionRequestParams = {
    ...request,
    options: [{ optionId: "allow-1", name: "Allow once", kind: "allow_once" }],
  };

  assert.deepEqual(acpPermissionDenial(withoutReject), {
    outcome: "fail_closed",
    reason: "ACP permission request provided no rejecting option",
  });
});

test("ACP permission denial treats option kind as a hint and requires a usable optionId", () => {
  const misleadingHint: AcpPermissionRequestParams = {
    ...request,
    options: [{ optionId: "", name: "Reject once", kind: "reject_once" }],
  };

  assert.deepEqual(acpPermissionDenial(misleadingHint), {
    outcome: "fail_closed",
    reason: "ACP permission request provided no rejecting option",
  });
});

test("ACP permission normalization rejects malformed locations and options", () => {
  assert.throws(
    () => correlateAcpPermissionRequest(
      {
        ...request,
        toolCall: { ...request.toolCall, locations: [{}] },
      },
      { sessionId: "workflow-session-1", agentSessionId: "agent-session-1", taskId: taskId("TASK-1"), toolName: "write_file" },
    ),
    /invalid ACP tool location/,
  );
  const malformedOptions = { ...request, options: [{}] } as unknown as AcpPermissionRequestParams;
  assert.throws(
    () => acpPermissionDenial(malformedOptions),
    /invalid ACP permission option/,
  );
});
