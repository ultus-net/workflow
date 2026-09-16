import assert from "node:assert/strict";
import test from "node:test";

import { AcpHostAdapter, taskId, type ProposedToolAction } from "../src/index.js";
import { AcpSessionDriver } from "../src/integrations/acp-session.js";
import { createWorkflowAcpPermissionResolver } from "../src/adapters/acp-workflow-resolver.js";
import type { AcpPermissionRequestParams } from "../src/adapters/acp-permission.js";

/**
 * OpenCode's ACP permission-request shape (captured live from opencode 1.18.31,
 * 2026-09-16): the edit-permission title is the TARGET PATH, not a tool name —
 * `toolNameFromTitle` therefore yields an unrecognized name, and classification
 * must fall back to the ACP kind field (the protocol's own discriminator)
 * before the fail-closed mutation default rejects the call as an "unknown ACP
 * mutation tool". Locations ride the request; rawInput carries filepath+diff.
 */

function resolver(correlation: Parameters<typeof createWorkflowAcpPermissionResolver>[0]["correlation"], seen: ProposedToolAction[]) {
  return createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation,
    authorize(action) {
      seen.push(action);
      return { kind: "allow" };
    },
  });
}

const options = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

const OPENCODE_EDIT_TITLE = "/tmp/wf-scheduled-probe-ws-EQ8Slb/note.txt";

test("classify falls back to the ACP kind when the title is not a tool name", () => {
  assert.equal(AcpSessionDriver.classify(OPENCODE_EDIT_TITLE), "mutation", "unrecognized titles stay fail-closed without a kind");
  assert.equal(AcpSessionDriver.classify(OPENCODE_EDIT_TITLE, "edit"), "mutation");
  assert.equal(AcpSessionDriver.classify(OPENCODE_EDIT_TITLE, "execute"), "process");
  assert.equal(AcpSessionDriver.classify(OPENCODE_EDIT_TITLE, "read"), "read");
  assert.equal(AcpSessionDriver.classify(OPENCODE_EDIT_TITLE, "fetch"), "network");
  assert.equal(AcpSessionDriver.classify(OPENCODE_EDIT_TITLE, "other"), "mutation", "the `other` kind fails closed");
  assert.equal(AcpSessionDriver.classify(OPENCODE_EDIT_TITLE, "brand-new-kind"), "mutation", "unknown kinds fail closed");
  assert.equal(AcpSessionDriver.classify("read_files"), "read", "recognized names keep their title classification");
  assert.equal(AcpSessionDriver.classify("run_commands", "read"), "process", "recognized names win over the kind");
});

test("OpenCode-shaped edit permission authorizes against its location subject", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "oc-session",
    taskId: taskId("TASK"),
    toolName: OPENCODE_EDIT_TITLE,
    capability: AcpSessionDriver.classify(OPENCODE_EDIT_TITLE, "edit"),
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "oc-session",
    toolCall: {
      toolCallId: "tool-edit",
      title: OPENCODE_EDIT_TITLE,
      kind: "edit",
      rawInput: { filepath: OPENCODE_EDIT_TITLE, diff: "--- note.txt\n+++ note.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n" },
      locations: [{ path: OPENCODE_EDIT_TITLE }],
    },
    options,
  };
  const decision = await resolve(request);
  assert.equal(decision.kind, "allow");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.capability, "mutation");
  assert.deepEqual(seen[0]!.subjects, [OPENCODE_EDIT_TITLE]);
});

test("OpenCode-shaped edit permission without locations extracts the rawInput filepath", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "oc-session",
    taskId: taskId("TASK"),
    toolName: OPENCODE_EDIT_TITLE,
    capability: "mutation",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "oc-session",
    toolCall: {
      toolCallId: "tool-edit-2",
      title: OPENCODE_EDIT_TITLE,
      kind: "edit",
      rawInput: { filepath: OPENCODE_EDIT_TITLE, diff: "…" },
      locations: [],
    },
    options,
  };
  const decision = await resolve(request);
  assert.equal(decision.kind, "allow");
  assert.deepEqual(seen[0]!.subjects, [OPENCODE_EDIT_TITLE]);
});

test("an edit-kind mutation with no subject anywhere fails closed", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "oc-session",
    taskId: taskId("TASK"),
    toolName: OPENCODE_EDIT_TITLE,
    capability: "mutation",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "oc-session",
    toolCall: {
      toolCallId: "tool-edit-3",
      title: OPENCODE_EDIT_TITLE,
      kind: "edit",
      rawInput: { diff: "…" },
      locations: [],
    },
    options,
  };
  await assert.rejects(() => resolve(request), /ACP permission request with kind edit has no authorization subject/);
  assert.equal(seen.length, 0, "a subjectless mutation must never reach authorize");
});

test("an unrecognized title with no kind still fails closed as an unknown mutation tool", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "oc-session",
    taskId: taskId("TASK"),
    toolName: OPENCODE_EDIT_TITLE,
    capability: "mutation",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "oc-session",
    toolCall: {
      toolCallId: "tool-edit-4",
      title: OPENCODE_EDIT_TITLE,
      kind: "brand-new-kind",
      rawInput: { filepath: OPENCODE_EDIT_TITLE },
      locations: [{ path: OPENCODE_EDIT_TITLE }],
    },
    options,
  };
  await assert.rejects(() => resolve(request), /unknown ACP mutation tool/);
  assert.equal(seen.length, 0);
});
