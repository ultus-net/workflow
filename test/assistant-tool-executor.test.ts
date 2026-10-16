import assert from "node:assert/strict";
import { test } from "node:test";

import type { TaskId } from "../src/kernel/contracts.js";
import type { ToolCapability } from "../src/application/host.js";
import { hostCapabilities } from "../src/application/host.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { classifyMcpTool, STRICTEST_MCP_TOOL_CLASS, type McpToolCapabilityMap } from "../src/integrations/mcp-tool-capability.js";
import { createAssistantToolExecutor, type AssistantToolDispatcher } from "../src/integrations/assistant-tool-executor.js";
import type { AssistantToolCall, AssistantToolContext, AssistantToolResult } from "../src/integrations/assistant-tool-loop.js";
import type { GuardCheckInput, GuardDecision } from "../src/integrations/guard-policy/index.js";
import type { GuardStatus, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import type { McpCapability, McpProvider } from "../src/adapters/mcp.js";
import type { OperatorAskHold, OperatorAskReply, OperatorAskRequest } from "../src/integrations/operator-ask-hold.js";

const TASK = "task-1" as TaskId;

/** A minimal guard provider: only `guardCheck` is exercised; the rest are inert. */
function fakeGuard(guardCheck: (input: GuardCheckInput) => Promise<GuardDecision>): WorkflowGuardProvider {
  const provider: McpProvider = {
    capabilities: (): Promise<readonly McpCapability[]> => Promise.resolve([]),
    invoke: (): Promise<unknown> => Promise.reject(new Error("not used")),
  };
  return {
    ...provider,
    guardCheck,
    guardStatus: (): Promise<GuardStatus> => Promise.resolve({ mode: "test", enforcement: "test", executesActions: false }),
    close: (): Promise<void> => Promise.resolve(),
  };
}

/** A minimal ask hold: records the parked request and returns a scripted reply. */
function fakeHold(reply: OperatorAskReply): { hold: OperatorAskHold; parked: OperatorAskRequest[] } {
  const parked: OperatorAskRequest[] = [];
  const hold: OperatorAskHold = {
    park: (request): Promise<OperatorAskReply> => {
      parked.push(request);
      return Promise.resolve(reply);
    },
    answer: (): boolean => false,
    pendingCount: 0,
    pending: [],
    cancelAll: (): void => {},
  };
  return { hold, parked };
}

/** A dispatcher that records calls and returns a fixed observation. */
function recordingDispatcher(): { dispatcher: AssistantToolDispatcher; calls: AssistantToolCall[]; classes: string[] } {
  const calls: AssistantToolCall[] = [];
  const classes: string[] = [];
  const dispatcher: AssistantToolDispatcher = {
    dispatch: (call, _context, toolClass): Promise<AssistantToolResult> => {
      calls.push(call);
      classes.push(toolClass.capability);
      return Promise.resolve({ callId: call.id, content: "dispatched: " + call.name });
    },
  };
  return { dispatcher, calls, classes };
}

function applicationWith(capabilities: readonly ToolCapability[] = ["read", "mutation", "process"]): WorkflowApplication {
  const graph = new TaskGraph([
    { id: TASK, title: "Assistant task", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [] },
  ]);
  return new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set<ToolCapability>(capabilities),
  );
}

const MAP: McpToolCapabilityMap = {
  read_tool: { capability: "read", mutating: false },
  mutation_tool: { capability: "mutation", mutating: true },
  process_tool: { capability: "process", mutating: true },
  network_tool: { capability: "network", mutating: true },
};

function callNamed(name: string, args: string = "{}"): AssistantToolCall {
  return { id: "call-1", name, arguments: args };
}

const CONTEXT: AssistantToolContext = { identity: "user", route: "coding", iteration: 0 };

test("an allowed read-class tool delegates to the dispatcher and returns its result", async () => {
  const { dispatcher, calls, classes } = recordingDispatcher();
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("read_tool"), CONTEXT);

  assert.equal(result.isError, undefined, "an allowed call carries no error flag");
  assert.equal(result.content, "dispatched: read_tool");
  assert.equal(calls.length, 1, "the dispatcher ran once");
  assert.equal(classes[0], "read", "the dispatcher saw the declared class");
});

test("a withheld capability denies with CAPABILITY_WITHHELD and never dispatches", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  // The application lacks `network`, so a network-class tool is withheld.
  const executor = createAssistantToolExecutor({
    application: applicationWith(["read", "mutation", "process"]),
    capabilities: MAP,
    dispatcher,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("network_tool"), CONTEXT);

  assert.equal(result.isError, true);
  assert.match(result.content, /CAPABILITY_WITHHELD/);
  assert.equal(calls.length, 0, "a denied call never reaches the dispatcher");
});

test("an unknown tool uses the strictest class and is withheld when process is not allowed", async () => {
  const { dispatcher, calls, classes } = recordingDispatcher();
  // `read` only: the strictest default (process) is withheld.
  const executor = createAssistantToolExecutor({
    application: applicationWith(["read"]),
    capabilities: MAP,
    dispatcher,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("unknown_tool"), CONTEXT);

  assert.equal(result.isError, true);
  assert.match(result.content, /CAPABILITY_WITHHELD/);
  assert.equal(calls.length, 0);
  // Confirm the classifier's default directly.
  assert.deepEqual(classifyMcpTool("unknown_tool", MAP), STRICTEST_MCP_TOOL_CLASS);
  assert.deepEqual(classes, []);
});

test("a guard deny returns an error observation and never dispatches", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const guard = fakeGuard(() => Promise.resolve({ decision: "deny", policy: "protected-path", reason: "protected path" }));
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    guard,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("mutation_tool"), CONTEXT);

  assert.equal(result.isError, true);
  assert.equal(result.content, "guard policy 'protected-path': protected path");
  assert.equal(calls.length, 0);
});

test("a guard ask with the operator rejecting fails closed and never dispatches", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const guard = fakeGuard(() => Promise.resolve({ decision: "ask", policy: "confirm-mutation", reason: "confirm", matched: "mutation_tool" }));
  const { hold, parked } = fakeHold("reject");
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    guard,
    hold,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("mutation_tool"), CONTEXT);

  assert.equal(result.isError, true);
  assert.equal(result.content, "operator rejected guard ask 'confirm-mutation'");
  assert.equal(calls.length, 0);
  assert.equal(parked.length, 1, "the ask was parked for the operator");
  assert.equal(parked[0]!.requestId, "call-1", "the ask carries the call id");
  assert.equal(parked[0]!.matched, "mutation_tool", "the matched surface rides the ask");
});

test("a guard ask approved once proceeds to dispatch", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const guard = fakeGuard(() => Promise.resolve({ decision: "ask", policy: "confirm-mutation", reason: "confirm" }));
  const { hold, parked } = fakeHold("once");
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    guard,
    hold,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("mutation_tool"), CONTEXT);

  assert.equal(result.isError, undefined);
  assert.equal(result.content, "dispatched: mutation_tool");
  assert.equal(calls.length, 1, "an approved ask dispatches");
  assert.equal(parked.length, 1);
  // A decision with no `matched` must not fabricate one on the ask.
  assert.equal(parked[0]!.matched, undefined);
});

test("a guard ask with no operator channel fails closed and never dispatches", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const guard = fakeGuard(() => Promise.resolve({ decision: "ask", policy: "confirm-mutation", reason: "confirm" }));
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    guard,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("mutation_tool"), CONTEXT);

  assert.equal(result.isError, true);
  assert.match(result.content, /no operator channel is configured/);
  assert.equal(calls.length, 0);
});

test("a guard throw fails closed and never dispatches", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const guard = fakeGuard(() => Promise.reject(new Error("guard service unavailable")));
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    guard,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("process_tool"), CONTEXT);

  assert.equal(result.isError, true);
  assert.equal(result.content, "guard unavailable (fail closed): guard service unavailable");
  assert.equal(calls.length, 0);
});

test("malformed arguments fail closed and never dispatch", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("read_tool", "{bad"), CONTEXT);

  assert.equal(result.isError, true);
  assert.match(result.content, /not valid JSON/);
  assert.equal(calls.length, 0);
});

test("an empty arguments string fails closed and never dispatches", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    sessionId: "session-1",
    taskId: TASK,
  });

  const result = await executor.execute(callNamed("read_tool", ""), CONTEXT);

  assert.equal(result.isError, true);
  assert.match(result.content, /not valid JSON/);
  assert.equal(calls.length, 0);
});

test("an unknown task fails closed via the kernel gate", async () => {
  const { dispatcher, calls } = recordingDispatcher();
  const executor = createAssistantToolExecutor({
    application: applicationWith(),
    capabilities: MAP,
    dispatcher,
    sessionId: "session-1",
    // A task id absent from the graph: `authorize` denies UNKNOWN_TASK. The
    // task check runs only after the read short-circuit (`workflow.ts:264`), so
    // this uses a mutating tool.
    taskId: "no-such-task" as TaskId,
  });

  const result = await executor.execute(callNamed("mutation_tool"), CONTEXT);

  assert.equal(result.isError, true);
  assert.match(result.content, /UNKNOWN_TASK/);
  assert.equal(calls.length, 0);
});
