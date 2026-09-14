import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

import { WorkflowCodingSession, type CodingSessionEvent } from "../src/application/coding-session.js";
import { taskId, type PolicyDecision } from "../src/kernel/contracts.js";
import { AcpSessionDriver } from "../src/integrations/acp-session.js";
import type { ProposedToolAction } from "../src/adapters/host.js";

function fakeAgent(mode: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["test/fixtures/fake-acp-agent.mjs", mode], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function driverFor(
  mode: string,
  authorize: (action: ProposedToolAction) => PolicyDecision = () => ({ kind: "allow" }),
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
  assert.ok(events.some((event) => event.type === "tool-proposal" && event.tool === "Read repo"));
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
