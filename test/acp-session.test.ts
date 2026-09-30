import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowCodingSession, type CodingSessionEvent } from "../src/application/coding-session.js";
import { taskId, type PolicyDecision } from "../src/kernel/contracts.js";
import { AcpSessionDriver, displayRawToolText } from "../src/integrations/acp-session.js";
import type { GuardDecision, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import { createOperatorAskHold, type OperatorAskHold } from "../src/integrations/operator-ask-hold.js";
import type { ModelUsageMetrics } from "../src/integrations/model-usage-proxy.js";
import { UNATTRIBUTED_TASK_ID, type TaskUsageSummary } from "../src/integrations/task-usage.js";
import { PermissionBroker } from "../src/ui/permission-broker.js";
import type { ProposedToolAction } from "../src/adapters/host.js";

const metrics = (overrides: Partial<ModelUsageMetrics> = {}): ModelUsageMetrics => ({
  requests: 0,
  usageEvents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  latestPromptTokens: undefined,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...overrides,
});

function fakeAgent(mode: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["test/fixtures/fake-acp-agent.mjs", mode], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function driverFor(
  mode: string,
  authorize: (action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision> = () => ({ kind: "allow" }),
  resumeFrom?: string,
): { driver: AcpSessionDriver; child: ChildProcessWithoutNullStreams } {
  const child = fakeAgent(mode);
  const driver = new AcpSessionDriver({
    child,
    authorize,
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: taskId("HEADLINE-TASK"),
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  });
  return { driver, child };
}

async function cleanup(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
}

test("ACP session driver projects a turn through the CodingSessionDriver contract", async () => {
  const { driver, child } = driverFor("done");
  const events: CodingSessionEvent[] = [];
  const session = new WorkflowCodingSession(driver);
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("say hi");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.deepEqual(session.snapshot(), { state: "completed", result: "working" });
  assert.ok(
    events.some((event) => event.type === "status" && event.status === "agent session id: fake-session-1"),
    "the agent session id must surface as a status event so the operator can resume it later",
  );
  assert.ok(events.some((event) => event.type === "assistant" && event.text === "working"));
  assert.ok(events.some((event) => event.type === "tool" && event.title === "Read repo" && event.status === "pending"));
  const completed = events.find((event) => event.type === "completed");
  assert.deepEqual(completed, { type: "completed", result: "working" });
  // G2's slash-command replacement: session/new config must be captured and
  // readable through the driver (not just discarded with the session id).
  assert.deepEqual(driver.config(), {
    availableModes: ["plan", "act"],
    availableModels: ["kimi-k2", "moonshot-v1"],
    configOptions: [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "kimi-k2",
      options: [{ value: "kimi-k2", name: "Kimi K2" }, { value: "moonshot-v1", name: "Moonshot v1" }],
    }],
  });
  assert.ok(
    events.some((event) => event.type === "status" && event.status === AcpSessionDriver.configSummary(driver.config()!)),
    "the session config summary must surface as a status event",
  );
});

test("ACP session driver projects usage, commands, and cumulative token totals", async () => {
  const { driver, child } = driverFor("rich");
  const session = new WorkflowCodingSession(driver);
  try {
    await driver.connect();
    await session.submit("measure usage");
    assert.deepEqual(driver.agentInfo(), { name: "fake-acp-agent", version: "0.0.0" });
    assert.deepEqual(driver.sessionCapabilities(), { close: true, fork: true, list: true, resume: true });
    assert.deepEqual(driver.availableCommands(), [{ name: "init", description: "guided setup" }]);
    assert.deepEqual(driver.acpUsageSnapshot(), { used: 12000, size: 128000, costUsd: 0.03 });
    assert.deepEqual(driver.turnTokenTotals(), { input: 12000, output: 500, turns: 1 });
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP session driver projects plan, thinking, typed tool calls, and session titles", async () => {
  const { driver, child } = driverFor("batch2");
  const events: CodingSessionEvent[] = [];
  const session = new WorkflowCodingSession(driver);
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("plan and act");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.equal(session.snapshot().state, "completed");

  const plans = events.filter((event) => event.type === "plan");
  assert.equal(plans.length, 2, "each plan update is one event");
  const firstPlan = plans[0];
  const secondPlan = plans[1];
  if (firstPlan === undefined || secondPlan === undefined || firstPlan.type !== "plan" || secondPlan.type !== "plan") {
    throw new Error("expected plan events");
  }
  assert.deepEqual(firstPlan.entries, [
    { id: "p1", content: "Inspect the workspace", status: "pending" },
    { id: "p2", content: "Apply the edit", status: "pending" },
  ]);
  assert.equal(secondPlan.entries[0]?.status, "completed");
  assert.equal(secondPlan.entries[1]?.status, "in_progress");

  const thoughts = events.filter((event) => event.type === "thought");
  assert.deepEqual(
    thoughts.map((event) => (event.type === "thought" ? event.text : "")),
    ["reasoning about ", "the fixture"],
  );

  const toolEvents = events.filter((event) => event.type === "tool");
  assert.equal(toolEvents.length, 3, "pending, in_progress, and completed tool events");
  const [call, start, done] = toolEvents;
  if (call === undefined || start === undefined || done === undefined || call.type !== "tool" || start.type !== "tool" || done.type !== "tool") {
    throw new Error("expected tool events");
  }
  assert.equal(call.callId, "tool-batch2");
  assert.equal(call.toolKind, "read");
  assert.equal(call.title, "Read workspace");
  assert.deepEqual(call.subjects, ["src/index.ts"]);
  assert.equal(call.rawInput, '{\n  "path": "src/index.ts"\n}', "structured rawInput is stringified for display");
  assert.equal(start.status, "in_progress");
  assert.equal(done.status, "completed");
  assert.equal(done.rawOutput, '[\n  {\n    "result": "file contents"\n  }\n]', "structured rawOutput is stringified for display");

  assert.ok(
    events.some((event) => event.type === "session-info" && event.title === "Fixture batch2 title"),
    "agent-provided session titles must surface",
  );
});

test("ACP session driver mutates config on the active agent session", async () => {
  const { driver, child } = driverFor("done");
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("start session");
    const config = await driver.setConfigOption("model", "moonshot-v1");
    assert.equal((config.configOptions as { currentValue?: string }[])[0]?.currentValue, "moonshot-v1");
    assert.deepEqual(driver.config(), config);
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP session driver accepts agent-originated complete config updates", async () => {
  const { driver, child } = driverFor("config-update");
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("start session");
    assert.equal((driver.config()?.configOptions as { currentValue?: string }[])[0]?.currentValue, "moonshot-v1");
    assert.ok(events.some((event) => event.type === "status" && event.status === "session config: options(1)"));
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("enforcement-altering config options are denied client-side, before any wire call", async () => {
  const { driver, child } = driverFor("done");
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("start session");
    await assert.rejects(driver.setConfigOption("bypass_permissions", true), /enforcement/);
    await assert.rejects(driver.setConfigOption("autoApprove", true), /enforcement/);
    // Benign options keep working.
    const config = await driver.setConfigOption("model", "moonshot-v1");
    assert.equal((config.configOptions as { currentValue?: string }[])[0]?.currentValue, "moonshot-v1");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("agent-originated enforcement-altering config updates are not retained and surface a denial", async () => {
  const { driver, child } = driverFor("bypass-config-update");
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("start session");
    assert.ok(
      events.some((event) => event.type === "status" && /denied agent-applied enforcement-altering config option/.test(event.status)),
      "the denial must surface as a visible status event",
    );
    const options = driver.config()?.configOptions as Array<{ id: string }>;
    assert.equal(
      options.some((option) => option.id === "bypass_permissions"),
      false,
      "the bypass option must not be retained in session config",
    );
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP session driver cancellation terminates the active turn", async () => {
  const { driver, child } = driverFor("done");
  const session = new WorkflowCodingSession(driver);
  let observedActivity!: () => void;
  const activity = new Promise<void>((resolve) => { observedActivity = resolve; });
  session.subscribe((event) => {
    if (event.type === "assistant") observedActivity();
  });
  try {
    const submit = session.submit("long work");
    await activity;
    await session.cancel();
    await submit;
    assert.deepEqual(session.snapshot(), { state: "cancelled" });
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP session driver fails closed on malformed session notifications", async () => {
  const { driver, child } = driverFor("invalid-update");
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("inspect repo");
    assert.deepEqual(session.snapshot(), { state: "failed", reason: "invalid ACP session update" });
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP session driver fails closed on malformed config option notifications", async () => {
  const { driver, child } = driverFor("invalid-config-update");
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("inspect config");
    assert.deepEqual(session.snapshot(), { state: "failed", reason: "invalid ACP config option update" });
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP permission requests are wired into the Workflow authorize path", async () => {
  const seen: ProposedToolAction[] = [];
  const authorize = (action: ProposedToolAction): PolicyDecision => {
    seen.push(action);
    return { kind: "allow" };
  };
  const { driver, child } = driverFor("permission", authorize);
  const events: CodingSessionEvent[] = [];
  const session = new WorkflowCodingSession(driver);
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("edit the file");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.equal(session.snapshot().state, "completed");
  assert.equal(seen.length, 1, "the permission request must reach Workflow authorize");
  assert.equal(seen[0]?.tool, "replace_in_file", "real Cline titles carry the tool name; fixture shape is faithful");

  assert.deepEqual(seen[0]?.subjects, ["target.txt"]);
  assert.equal(seen[0]?.taskId, taskId("HEADLINE-TASK"));
});

test("ACP permission denial selects the agent-provided rejecting option and still terminates the turn", async () => {
  const seen: ProposedToolAction[] = [];
  const authorize = (action: ProposedToolAction): PolicyDecision => {
    seen.push(action);
    return { kind: "deny", code: "CAPABILITY_WITHHELD", reason: "denied by test" };
  };
  const { driver, child } = driverFor("permission", authorize);
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("edit the file");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.equal(seen.length, 1);
  // The fixture deterministically completes after the permission answer; a
  // deadlock here would hang the submit, so the terminal state is meaningful.
  assert.equal(session.snapshot().state, "completed");
});

test("ACP permission flow parks for the operator in ask mode and completes after the answer", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const { driver, child } = driverFor("permission", (action) => broker.intercept(action, () => ({ kind: "allow" })));
  const session = new WorkflowCodingSession(driver);
  let submit: Promise<void> | undefined;
  try {
    submit = session.submit("edit the file");
    // Wall-clock budget: agent-process I/O is not done in setImmediate turns.
    const deadline = Date.now() + 5_000;
    while (broker.pendingRequest() === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const request = broker.pendingRequest();
    assert.ok(request !== undefined, "the gated action parks as an operator prompt in ask mode");
    assert.equal(request.tool, "replace_in_file");
    assert.ok(request.subjects.includes("target.txt"));
    assert.equal(broker.answer(request.id, "allow_once"), true);
    await submit;
    assert.equal(session.snapshot().state, "completed");
  } finally {
    // Cancel any parked prompt first so the awaiting turn can always settle.
    broker.cancelPending("test cleanup");
    await driver.dispose();
    if (submit !== undefined) await submit.catch(() => undefined);
    await cleanup(child);
  }
});

test("ACP session driver resumes via session/load instead of creating a new session", async () => {
  const { driver, child } = driverFor("done", () => ({ kind: "allow" }), "fake-session-1");
  const events: CodingSessionEvent[] = [];
  const session = new WorkflowCodingSession(driver);
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("continue");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.ok(
    events.some((event) => event.type === "assistant" && event.text === "earlier agent turn"),
    "resume must project the replayed history before the turn runs",
  );
  assert.equal(session.snapshot().state, "completed");
});

test("ACP session driver retains optional config returned while loading a session", async () => {
  const { driver, child } = driverFor("load-config", () => ({ kind: "allow" }), "fake-session-1");
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("continue");
    assert.equal((driver.config()?.configOptions as { currentValue?: string }[])[0]?.currentValue, "kimi-k2");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP session driver refuses session/load when the agent does not advertise it", async () => {
  const { driver, child } = driverFor("no-load", () => ({ kind: "allow" }), "fake-session-1");
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("continue");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.deepEqual(session.snapshot(), { state: "failed", reason: "ACP agent does not advertise session/load support" });
});

test("unknown tool titles fail closed to the mutation capability", async () => {
  assert.equal(AcpSessionDriver.classify("run_commands"), "process");
  assert.equal(AcpSessionDriver.classify("read_files"), "read");
  assert.equal(AcpSessionDriver.classify("web_fetch"), "network");
  assert.equal(AcpSessionDriver.classify("brand-new-dangerous-tool"), "mutation");
});

test("title detail is stripped to the tool name before classification", () => {
  assert.equal(AcpSessionDriver.toolNameFromTitle("run_commands: ls -la /tmp/x"), "run_commands");
  assert.equal(AcpSessionDriver.toolNameFromTitle("replace_in_file"), "replace_in_file");
  assert.equal(AcpSessionDriver.toolNameFromTitle(undefined), "unknown");
  assert.equal(AcpSessionDriver.toolNameFromTitle("   "), "unknown");
});

test("tool status mapping tolerates Cline's failed alias and stays pending on unknowns", () => {
  assert.equal(AcpSessionDriver.toolStatus("failed"), "error");
  assert.equal(AcpSessionDriver.toolStatus("error"), "error");
  assert.equal(AcpSessionDriver.toolStatus("in_progress"), "in_progress");
  assert.equal(AcpSessionDriver.toolStatus("completed"), "completed");
  assert.equal(AcpSessionDriver.toolStatus("cancelled"), "cancelled");
  assert.equal(AcpSessionDriver.toolStatus("weird"), "pending");
});

test("raw tool I/O is stringified, emptiness-dropped, and size-capped", () => {
  assert.equal(displayRawToolText({ path: "a.ts" }), '{\n  "path": "a.ts"\n}');
  assert.equal(displayRawToolText("plain output"), "plain output");
  assert.equal(displayRawToolText({}), undefined);
  assert.equal(displayRawToolText([]), undefined);
  assert.equal(displayRawToolText(""), undefined);
  assert.equal(displayRawToolText(42), undefined);
  const huge = displayRawToolText({ dump: "x".repeat(64 * 1024) });
  assert.ok(huge !== undefined && huge.length < 9 * 1024, "oversized I/O is truncated");
  assert.ok(huge?.endsWith("… truncated"));
});

test("ACP session driver projects plan updates as typed plan entries", async () => {
  const { driver, child } = driverFor("plan-update");
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("start session");
    const plan = events.find(
      (event): event is Extract<CodingSessionEvent, { type: "plan" }> => event.type === "plan",
    );
    assert.ok(plan !== undefined, "the plan must surface as a typed plan event");
    assert.equal(plan.entries.filter((entry) => entry.status === "completed").length, 1);
    assert.ok(plan.entries.some((entry) => entry.content === "Fix the off-by-one in the parser"));
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("ACP session driver projects session_info_update as a typed session-info title", async () => {
  const { driver, child } = driverFor("session-info");
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("start session");
    const info = events.find((event) => event.type === "session-info" && event.title === "Probe session title");
    assert.ok(info !== undefined, "session_info_update must surface as a session-info event");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

test("W111: a completed ACP turn publishes the per-task delta through the attribution sink", async () => {
  const published: Omit<TaskUsageSummary, "recordedAt">[] = [];
  // begin() reads once, end(true) reads once: baseline then turn end.
  const readings = [
    metrics({ requests: 1, promptTokens: 40, completionTokens: 5, totalTokens: 45, costUsd: 0.002, cacheReadTokens: 8, cacheCreateTokens: 1 }),
    metrics({ requests: 3, promptTokens: 140, completionTokens: 15, totalTokens: 155, costUsd: 0.007, cacheReadTokens: 28, cacheCreateTokens: 3 }),
  ];
  let index = 0;
  const child = fakeAgent("done");
  const driver = new AcpSessionDriver({
    child,
    authorize: () => ({ kind: "allow" }),
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    // The lazy pointer the interactive surfaces pass: read at boundary time.
    taskId: () => taskId("W42"),
    taskUsage: { usage: () => readings[index++], record: (delta) => published.push(delta) },
  });
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("say hi");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.equal(session.snapshot().state, "completed");
  assert.equal(published.length, 1, "a completed turn publishes exactly one delta");
  assert.deepEqual(published[0], {
    taskId: "W42",
    requests: 2,
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    costUsd: 0.005,
    cacheReadTokens: 20,
    cacheCreateTokens: 2,
  });
});

test("W111: a failed ACP turn publishes no delta through the attribution sink", async () => {
  const published: Omit<TaskUsageSummary, "recordedAt">[] = [];
  const child = fakeAgent("invalid-update");
  const driver = new AcpSessionDriver({
    child,
    authorize: () => ({ kind: "allow" }),
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: () => taskId("W42"),
    taskUsage: { usage: () => metrics({ totalTokens: 100 }), record: (delta) => published.push(delta) },
  });
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("inspect repo");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.equal(session.snapshot().state, "failed");
  assert.equal(published.length, 0, "a failed turn publishes no delta (a partial bill is not honest)");
});

test("W111: a cancelled ACP turn publishes no delta; a throwing pointer read records the absence", async () => {
  const published: Omit<TaskUsageSummary, "recordedAt">[] = [];
  const child = fakeAgent("done");
  const driver = new AcpSessionDriver({
    child,
    authorize: () => ({ kind: "allow" }),
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: () => {
      throw new TypeError("no active workflow task selected");
    },
    taskUsage: { usage: () => metrics({ totalTokens: 100 }), record: (delta) => published.push(delta) },
  });
  const session = new WorkflowCodingSession(driver);
  let observedActivity!: () => void;
  const activity = new Promise<void>((resolve) => { observedActivity = resolve; });
  session.subscribe((event) => {
    if (event.type === "assistant") observedActivity();
  });
  try {
    const submit = session.submit("long work");
    await activity;
    await session.cancel();
    await submit;
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.deepEqual(session.snapshot(), { state: "cancelled" });
  assert.equal(published.length, 0, "a cancelled turn publishes no delta");
});

test("W111: an absent active-task pointer on a completed ACP turn records the unattributed absence", async () => {
  const published: Omit<TaskUsageSummary, "recordedAt">[] = [];
  const readings = [metrics(), metrics({ totalTokens: 70 })];
  let index = 0;
  const child = fakeAgent("done");
  const driver = new AcpSessionDriver({
    child,
    authorize: () => ({ kind: "allow" }),
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: () => {
      throw new TypeError("no active workflow task selected");
    },
    taskUsage: { usage: () => readings[index++], record: (delta) => published.push(delta) },
  });
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("say hi");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
  assert.equal(session.snapshot().state, "completed");
  assert.equal(published.length, 1, "the spend is still recorded, attributed to the absence");
  assert.equal(published[0]?.taskId, UNATTRIBUTED_TASK_ID, "an absent pointer is never guessed");
  assert.equal(published[0]?.totalTokens, 70);
});

test("the hub fs server rejects relative paths fail-closed before authorization", async () => {
  const seen: ProposedToolAction[] = [];
  const { driver, child } = driverFor("fs-relative-write", (action) => {
    seen.push(action);
    return { kind: "allow" };
  });
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("write the file");
    const completed = events.find((event): event is Extract<CodingSessionEvent, { type: "completed" }> => event.type === "completed");
    assert.ok(completed !== undefined, "the turn must complete with the fs rejection surfaced as the agent's report");
    assert.match(completed.result, /must be absolute/, "the agent must see the fail-closed rejection");
    assert.equal(seen.length, 0, "a relative-path delegation must never reach authorization");
  } finally {
    await driver.dispose();
    await cleanup(child);
  }
});

// ── P6 fs-server seat: the guard ASK HOLD (issue #285) ─────────────────────
//
// The hub-implemented ACP fs server mutates in-process immediately after the
// guard check, so a guard `ask` must complete the operator hold BEFORE the
// write — there is no queue to return to. A guard `ask` parks on an injected
// hold, then performs the write on approval and refuses it (throws, surfaced
// as a JSON-RPC error) on reject/timeout (fail closed). With no hold attached
// the ask fails closed (the brief's Q3 posture). `trustedRole` stays unsupplied.

function askGuard(): WorkflowGuardProvider {
  return {
    async capabilities() {
      return [{ name: "guard_check" }];
    },
    async invoke() {
      throw new Error("unused");
    },
    async guardCheck(): Promise<GuardDecision> {
      return { decision: "ask", policy: "promotion-gate", reason: "promotion requires operator approval" };
    },
    async guardStatus() {
      throw new Error("unused");
    },
    close: async () => undefined,
  };
}

function fsSeatDriver(
  workspace: string,
  hold?: OperatorAskHold,
): { driver: AcpSessionDriver; child: ChildProcessWithoutNullStreams } {
  const child = fakeAgent("fs-absolute-write");
  const driver = new AcpSessionDriver({
    child,
    authorize: () => ({ kind: "allow" }),
    workspace,
    workspaceSessionId: "workflow-session",
    taskId: taskId("HEADLINE-TASK"),
    guard: askGuard(),
    ...(hold === undefined ? {} : { hold }),
  });
  return { driver, child };
}

/** Polls the hold until the seat has parked the ask (timer/microtask driven). */
async function waitForFsParked(hold: OperatorAskHold): Promise<void> {
  for (let i = 0; i < 500 && hold.pendingCount === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("P6 fs seat: a guard ask parks before the write and the operator's allow releases it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-fs-hold-"));
  const target = join(dir, "held.txt");
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  const { driver, child } = fsSeatDriver(dir, hold);
  const session = new WorkflowCodingSession(driver);
  try {
    const submit = session.submit(target);
    await waitForFsParked(hold);
    assert.equal(hold.pendingCount, 1, "a guard ask must park on the operator hold before the write");
    assert.equal(hold.pending[0]?.policy, "promotion-gate");
    await assert.rejects(readFile(target, "utf8"), "the write must not happen while the ask is held");
    hold.answer(hold.pending[0]!.requestId, "once");
    await submit;
    assert.equal(await readFile(target, "utf8"), "held", "the operator's allow releases the write");
    assert.equal(hold.pendingCount, 0);
  } finally {
    await driver.dispose();
    await cleanup(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("P6 fs seat: the operator's reject refuses the write fail-closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-fs-hold-"));
  const target = join(dir, "held.txt");
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  const { driver, child } = fsSeatDriver(dir, hold);
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    const submit = session.submit(target);
    await waitForFsParked(hold);
    hold.answer(hold.pending[0]!.requestId, "reject");
    await submit;
    const completed = events.find((event): event is Extract<CodingSessionEvent, { type: "completed" }> => event.type === "completed");
    assert.ok(completed !== undefined);
    assert.match(completed.result, /operator reject or hold timeout/, "the agent must see the fail-closed rejection");
    await assert.rejects(readFile(target, "utf8"), "a rejected ask must never write");
  } finally {
    await driver.dispose();
    await cleanup(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("P6 fs seat: an unanswered hold times out and refuses the write fail-closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-fs-hold-"));
  const target = join(dir, "held.txt");
  const hold = createOperatorAskHold({ timeoutMs: 5 });
  const { driver, child } = fsSeatDriver(dir, hold);
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.submit(target);
    const completed = events.find((event): event is Extract<CodingSessionEvent, { type: "completed" }> => event.type === "completed");
    assert.ok(completed !== undefined);
    assert.match(completed.result, /operator reject or hold timeout/, "an unanswered hold must fail closed");
    await assert.rejects(readFile(target, "utf8"), "a timed-out ask must never write");
  } finally {
    await driver.dispose();
    await cleanup(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("P6 fs seat: a guard ask fails closed when no operator hold is attached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-fs-hold-"));
  const target = join(dir, "held.txt");
  const { driver, child } = fsSeatDriver(dir);
  const session = new WorkflowCodingSession(driver);
  const events: CodingSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.submit(target);
    const completed = events.find((event): event is Extract<CodingSessionEvent, { type: "completed" }> => event.type === "completed");
    assert.ok(completed !== undefined);
    assert.match(completed.result, /no operator hold attached/, "the no-operator posture must be an honest fail-closed deny");
    assert.match(completed.result, /promotion-gate/);
    await assert.rejects(readFile(target, "utf8"), "a no-operator ask must never write");
  } finally {
    await driver.dispose();
    await cleanup(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("P6 fs seat: a broker-composed driver rides the broker's one answer transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-fs-broker-"));
  const target = join(dir, "held.txt");
  const broker = new PermissionBroker();
  const child = fakeAgent("fs-absolute-write");
  const driver = new AcpSessionDriver({
    child,
    authorize: () => ({ kind: "allow" }),
    workspace: dir,
    workspaceSessionId: "workflow-session",
    taskId: taskId("HEADLINE-TASK"),
    guard: askGuard(),
    permissionBroker: broker,
  });
  const session = new WorkflowCodingSession(driver);
  try {
    const submit = session.submit(target);
    for (let i = 0; i < 500 && broker.pendingRequest("workflow-session") === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const pending = broker.pendingRequest("workflow-session");
    assert.ok(pending !== undefined, "the fs seat's ask must ride the broker's one transport");
    assert.equal(pending.tool, "promotion-gate");
    assert.equal(broker.answer(pending.id, "allow_once", "workflow-session"), true, "the broker answer releases the write");
    await submit;
    assert.equal(await readFile(target, "utf8"), "held", "the operator's allow releases the write");
    assert.equal(broker.pendingRequest("workflow-session"), undefined);
  } finally {
    await driver.dispose();
    await cleanup(child);
    await rm(dir, { recursive: true, force: true });
  }
});
