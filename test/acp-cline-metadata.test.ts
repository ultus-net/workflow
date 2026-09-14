import assert from "node:assert/strict";
import test from "node:test";

import { AcpHostAdapter, taskId, type ProposedToolAction } from "../src/index.js";
import { createWorkflowAcpPermissionResolver } from "../src/adapters/acp-workflow-resolver.js";
import type { AcpPermissionRequestParams } from "../src/adapters/acp-permission.js";

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

test("Cline read_files permission maps file subjects and read capability", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "read_files",
    capability: "read",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-read",
      title: "read_files",
      kind: "read",
      rawInput: { files: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }] },
    },
    options,
  };

  assert.deepEqual(await resolve(request), { kind: "allow" });
  assert.deepEqual(seen[0], {
    sessionId: "workflow-session",
    taskId: "TASK",
    tool: "read_files",
    capability: "read",
    requiredCapabilities: ["read"],
    mutating: false,
    subjects: ["/repo/a.ts", "/repo/b.ts"],
    input: { files: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }] },
  });
});

test("Cline editor permission maps path subject and mutation capability", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "editor",
    capability: "mutation",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-edit",
      title: "editor",
      kind: "edit",
      rawInput: { path: "/repo/a.ts", old_text: "before", new_text: "after" },
    },
    options,
  };

  assert.deepEqual(await resolve(request), { kind: "allow" });
  assert.deepEqual(seen[0]?.subjects, ["/repo/a.ts"]);
  assert.deepEqual(seen[0]?.requiredCapabilities, ["mutation"]);
  assert.equal(seen[0]?.mutating, true);
});

test("Cline shell permission maps cwd subject, keeps command in input, and process capability", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "execute_command",
    capability: "process",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-shell",
      title: "execute_command",
      kind: "execute",
      rawInput: { command: "git status --short", cwd: "/repo" },
    },
    options,
  };

  assert.deepEqual(await resolve(request), { kind: "allow" });
  // Commands are never subjects: the kernel checks every subject against the
  // workspace as a path, so the command text stays in `input` for policy.
  assert.deepEqual(seen[0]?.subjects, ["/repo"]);
  assert.deepEqual(seen[0]?.input, { command: "git status --short", cwd: "/repo" });
  assert.deepEqual(seen[0]?.requiredCapabilities, ["process"]);
  assert.equal(seen[0]?.mutating, true);
});

test("Cline write_file permission maps path subject and mutation capability", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "write_file",
    capability: "mutation",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-write",
      title: "write_file",
      kind: "edit",
      rawInput: { path: "/repo/new.ts", content: "export {};\n" },
    },
    options,
  };

  assert.deepEqual(await resolve(request), { kind: "allow" });
  assert.deepEqual(seen[0]?.subjects, ["/repo/new.ts"]);
  assert.deepEqual(seen[0]?.requiredCapabilities, ["mutation"]);
  assert.equal(seen[0]?.mutating, true);
});

test("Cline permission mapping fails closed when write_file has no subject path", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "write_file",
    capability: "mutation",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-write",
      title: "write_file",
      kind: "edit",
      rawInput: { content: "export {};\n" },
    },
    options,
  };

  await assert.rejects(() => resolve(request), /no authorization subject/);
  assert.equal(seen.length, 0);
});

test("Cline permission mapping fails closed when a shell request has no command", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "execute_command",
    capability: "process",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-shell",
      title: "execute_command",
      kind: "execute",
      rawInput: { cwd: "/repo" },
    },
    options,
  };

  await assert.rejects(() => resolve(request), /no command/);
  assert.equal(seen.length, 0);
});

test("Cline permission mapping fails closed on partially malformed read_files metadata", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "read_files",
    capability: "read",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-read",
      title: "read_files",
      kind: "read",
      rawInput: { files: [{ path: "/repo/a.ts" }, { path: " " }, {}] },
    },
    options,
  };

  await assert.rejects(() => resolve(request), /invalid ACP read_files path/);
  assert.equal(seen.length, 0);
});

test("Cline permission mapping fails closed on whitespace-only path and command metadata", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "editor",
    capability: "mutation",
  }, seen);
  await assert.rejects(
    () => resolve({
      sessionId: "cline-session",
      toolCall: { toolCallId: "tool-edit", title: "editor", kind: "edit", rawInput: { path: "   " } },
      options,
    }),
    /no authorization subject/,
  );

  const shellResolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "execute_command",
    capability: "process",
  }, seen);
  await assert.rejects(
    () => shellResolve({
      sessionId: "cline-session",
      toolCall: { toolCallId: "tool-shell", title: "execute_command", kind: "execute", rawInput: { command: "   " } },
      options,
    }),
    /no command/,
  );
  assert.equal(seen.length, 0);
});

test("Cline permission mapping fails closed for unknown mutation tools but preserves read-only unknown tools", async () => {
  const seen: ProposedToolAction[] = [];
  const mutationResolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "custom_mutator",
    capability: "mutation",
  }, seen);
  await assert.rejects(
    () => mutationResolve({
      sessionId: "cline-session",
      toolCall: { toolCallId: "tool-custom", title: "custom_mutator", kind: "other", rawInput: {} },
      options,
    }),
    /unknown ACP mutation tool/,
  );

  const readResolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "custom_reader",
    capability: "read",
  }, seen);
  assert.deepEqual(
    await readResolve({
      sessionId: "cline-session",
      toolCall: { toolCallId: "tool-custom", title: "custom_reader", kind: "read", rawInput: {} },
      options,
    }),
    { kind: "allow" },
  );
  assert.equal(seen.length, 1);
});

test("Cline permission mapping fails closed when a recognized file tool has no subject path", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver({
    sessionId: "workflow-session",
    agentSessionId: "cline-session",
    taskId: taskId("TASK"),
    toolName: "editor",
    capability: "mutation",
  }, seen);
  const request: AcpPermissionRequestParams = {
    sessionId: "cline-session",
    toolCall: {
      toolCallId: "tool-edit",
      title: "editor",
      kind: "edit",
      rawInput: {},
    },
    options,
  };

  await assert.rejects(() => resolve(request), /no authorization subject/);
  assert.equal(seen.length, 0);
});
