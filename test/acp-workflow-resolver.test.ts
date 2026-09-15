import assert from "node:assert/strict";
import test from "node:test";

import { AcpHostAdapter, taskId, type PolicyDecision, type ProposedToolAction } from "../src/index.js";
import { createWorkflowAcpPermissionResolver } from "../src/adapters/acp-workflow-resolver.js";
import type { GuardCheckInput, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
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

// ── Plan Task G2: guard dispatcher parity on ACP surfaces ──────────────────

function stubGuard(
  decision: { decision: "allow" | "deny" | "ask"; policy: string; reason: string } | Error,
): { guard: WorkflowGuardProvider; inputs: GuardCheckInput[] } {
  const inputs: GuardCheckInput[] = [];
  return {
    inputs,
    guard: {
      async capabilities() {
        return [{ name: "guard_check" }];
      },
      async invoke() {
        throw new Error("unused");
      },
      async guardCheck(input) {
        inputs.push(input);
        if (decision instanceof Error) throw decision;
        return decision;
      },
      async guardStatus() {
        throw new Error("unused");
      },
      close: async () => undefined,
    },
  };
}

function guardResolver(guard: WorkflowGuardProvider, toolName: string, capability: "process" | "mutation" | "read") {
  return createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation: {
      sessionId: "workflow-session-1",
      agentSessionId: "agent-session-1",
      taskId: taskId("TASK-1"),
      toolName,
      capability,
    },
    authorize: (): PolicyDecision => ({ kind: "allow" }),
    guard,
  });
}

test("ACP resolver consults the guard after kernel authorization and denies on guard policy", async () => {
  const { guard, inputs } = stubGuard({ decision: "deny", policy: "destructive-shell", reason: "production deploy outside change window" });
  const resolver = guardResolver(guard, "run_commands", "process");

  const shellRequest: AcpPermissionRequestParams = {
    ...request,
    toolCall: {
      toolCallId: "tool-shell",
      title: "Run commands",
      kind: "execute",
      rawInput: { command: "make deploy-production", cwd: "/repo" },
      locations: [{ path: "/repo" }],
    },
  };
  const decision = await resolver(shellRequest);

  assert.deepEqual(inputs[0], { action: "shell", command: "make deploy-production" });
  assert.equal(inputs.length, 1);
  assert.match((decision as { reason: string }).reason, /guard policy 'destructive-shell': production deploy outside change window/);
  assert.equal(decision.kind, "deny");
});

test("ACP resolver allows when the guard allows, and unmapped tools never reach the guard", async () => {
  const { guard, inputs } = stubGuard({ decision: "allow", policy: "ok", reason: "fine" });
  const resolver = guardResolver(guard, "run_commands", "process");

  const shellRequest: AcpPermissionRequestParams = {
    ...request,
    toolCall: {
      toolCallId: "tool-shell-ok",
      title: "Run commands",
      kind: "execute",
      rawInput: { command: "git status" },
      locations: [],
    },
  };
  assert.deepEqual(await resolver(shellRequest), { kind: "allow" });
  assert.equal(inputs.length, 1);

  const searchResolver = guardResolver(guard, "search_codebase", "read");
  const searchRequest: AcpPermissionRequestParams = {
    ...request,
    toolCall: { toolCallId: "tool-search", title: "Search codebase", kind: "search", rawInput: { query: "x", path: "src" }, locations: [{ path: "src" }] },
  };
  assert.deepEqual(await searchResolver(searchRequest), { kind: "allow" });
  assert.equal(inputs.length, 1, "unmapped tools must not hit the guard");
});

test("ACP resolver fails closed when the guard itself errors", async () => {
  const { guard } = stubGuard(new Error("guard server crashed"));
  const resolver = guardResolver(guard, "write_to_file", "mutation");

  const writeRequest: AcpPermissionRequestParams = {
    ...request,
    toolCall: {
      toolCallId: "tool-write",
      title: "Write to file",
      kind: "edit",
      rawInput: { path: "src/a.ts", content: "x" },
      locations: [{ path: "src/a.ts" }],
    },
  };
  const decision = await resolver(writeRequest);
  assert.equal(decision.kind, "deny");
  assert.match((decision as { reason: string }).reason, /guard unavailable \(fail closed\): guard server crashed/);
});

// ── Plan Task F1: skill delivery observation on allowed read_skill calls ──

function skillReadResolver(delivered: string[], toolName: string, rawInput: unknown) {
  return createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation: {
      sessionId: "workflow-session-1",
      agentSessionId: "agent-session-1",
      taskId: taskId("TASK-1"),
      toolName,
      capability: "read",
    },
    authorize: (): PolicyDecision => ({ kind: "allow" }),
    onSkillRead: (skill) => delivered.push(skill),
  });
}

test("an allowed read_skill call records the delivered skill", async () => {
  const delivered: string[] = [];
  const resolver = skillReadResolver(delivered, "read_skill", { name: "test-driven-development" });
  const request_: AcpPermissionRequestParams = {
    ...request,
    toolCall: { toolCallId: "tool-skill", title: "read_skill: TDD", kind: "read", rawInput: { name: "test-driven-development" }, locations: [] },
  };
  assert.deepEqual(await resolver(request_), { kind: "allow" });
  assert.deepEqual(delivered, ["test-driven-development"]);

  // Prefixed MCP tool names match too.
  const prefixed = skillReadResolver(delivered, "skills-mcp__read_skill", { skill: "code-review" });
  assert.deepEqual(await prefixed({
    ...request_,
    toolCall: { ...request_.toolCall, title: "skills-mcp__read_skill: Review", rawInput: { skill: "code-review" } },
  }), { kind: "allow" });
  assert.deepEqual(delivered, ["test-driven-development", "code-review"]);
});

test("non-skill tool calls never record a delivery", async () => {
  const delivered: string[] = [];
  const resolver = skillReadResolver(delivered, "read_file", { path: "src/a.ts" });
  await resolver({
    ...request,
    toolCall: { toolCallId: "tool-read", title: "Read file", kind: "read", rawInput: { path: "src/a.ts" }, locations: [{ path: "src/a.ts" }] },
  });
  assert.deepEqual(delivered, []);
});
