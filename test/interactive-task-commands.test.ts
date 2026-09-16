import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WorkflowCodingSession, type CodingSessionEvent } from "../src/application/coding-session.js";
import {
  NO_ACTIVE_TASK_ID,
  activeTaskCorrelation,
  createTaskCommandPort,
} from "../src/application/task-commands.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { AcpSessionDriver } from "../src/integrations/acp-session.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type PolicyDecision, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import type { ProposedToolAction } from "../src/adapters/host.js";

/**
 * W046: per-prompt task decomposition for interactive sessions. The task
 * command port drives canonical task lifecycle through application commands
 * only (kernel validation, no TaskGraph exposure); the ACP driver correlates
 * proposals with the ACTIVE eligible task; blocked decomposition cannot
 * mutate; evidence drives the unlock.
 */

function interactiveApplication(seedTitle = "Interactive coding session"): WorkflowApplication {
  const seed: WorkflowTask = {
    id: taskId("SEED"),
    title: seedTitle,
    state: "IN_PROGRESS",
    dependencies: [],
    requiredEvidence: [],
  };
  const application = new WorkflowApplication(
    new TaskGraph([seed]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    "/repo",
  );
  application.startInteractiveTask();
  return application;
}

function mutatingAction(id: string): ProposedToolAction {
  return {
    sessionId: "session",
    taskId: taskId(id),
    tool: "edit",
    capability: "mutation",
    mutating: true,
    subjects: ["/repo/file.txt"],
    input: {},
  };
}

// ── The port: create / activate / complete / retry through application commands ──

test("the port creates decomposed tasks and the kernel keeps them BLOCKED until dependencies verify", () => {
  const application = interactiveApplication();
  const port = createTaskCommandPort(application);
  const prerequisite = port.createTask({ title: "Write the parser" });
  const dependent = port.createTask({ title: "Use the parser", dependencies: [prerequisite] });
  assert.equal(application.snapshot().tasks.find((task) => task.id === dependent)?.state, "BLOCKED");

  // Blocked work cannot mutate: the dependent task fails the application gate.
  const decision = application.authorize(mutatingAction(dependent));
  assert.equal(decision.kind, "deny");

  // Blocked decomposition cannot be activated either — never guess.
  assert.throws(() => port.activateTask(dependent), /state BLOCKED/);
});

test("kernel validation rides through the port: missing deps, cycles, duplicates reject", () => {
  const application = interactiveApplication();
  const port = createTaskCommandPort(application);
  assert.throws(() => port.createTask({ title: "bad", dependencies: [taskId("no-such-task")] }), /dependency/);
  const first = port.createTask({ title: "a" });
  const second = port.createTask({ title: "b", dependencies: [first] });
  const third = port.createTask({ title: "c", dependencies: [second] });
  assert.throws(() => application.addDependency(first, third), /cyclic|cycle/);
  assert.throws(() => port.createTask({ id: first, title: "duplicate" }), /duplicate/);
});

test("the port activates, completes with evidence, and unlocks dependents — the deterministic flow", () => {
  const application = interactiveApplication();
  const port = createTaskCommandPort(application);
  const prerequisite = port.createTask({
    title: "Write the parser",
    requiredEvidence: [{ authority: "environment", subject: "parser-test" }],
  });
  // No dependencies: BLOCKED at insert, READY after the readiness recompute.
  assert.equal(application.snapshot().tasks.find((task) => task.id === prerequisite)?.state, "READY");

  port.activateTask(prerequisite);
  assert.equal(port.activeTaskId(), prerequisite);
  assert.equal(application.authorize(mutatingAction(prerequisite)).kind, "allow");

  // Completion is evidence-driven: fresh environment evidence verifies, and
  // tool success alone would never have been enough.
  port.completeTask(prerequisite, [{ subject: "parser-test", detail: "node --test green" }]);
  assert.equal(application.snapshot().tasks.find((task) => task.id === prerequisite)?.state, "VERIFIED");

  const dependent = port.createTask({ title: "Use the parser", dependencies: [prerequisite] });
  assert.equal(application.snapshot().tasks.find((task) => task.id === dependent)?.state, "READY");
  port.activateTask(dependent);
  assert.equal(port.activeTaskId(), dependent);
  assert.equal(application.authorize(mutatingAction(dependent)).kind, "allow");
});

test("the port retries failed tasks and completion guards illegal states", () => {
  const application = interactiveApplication();
  const port = createTaskCommandPort(application);
  const task = port.createTask({ title: "flaky" });
  port.activateTask(task);
  application.transition(task, "FAILED");
  port.retryTask(task);
  assert.equal(application.snapshot().tasks.find((entry) => entry.id === task)?.state, "READY");

  // Completing an unknown or not-started task refuses.
  assert.throws(() => port.completeTask(taskId("no-such-task"), []), /unknown/);
  assert.throws(() => port.completeTask(task, []), /state READY/);
  assert.throws(() => port.activateTask(taskId("no-such-task")), /unknown/);
});

test("activeTaskCorrelation fails closed with a sentinel when no task is IN_PROGRESS", () => {
  const application = interactiveApplication();
  const correlate = activeTaskCorrelation(application);
  assert.equal(correlate(), taskId("SEED"));
  application.transition(taskId("SEED"), "FAILED");
  assert.equal(correlate(), NO_ACTIVE_TASK_ID);
  // The sentinel is a non-existent id: the application gate denies UNKNOWN_TASK.
  assert.equal(application.authorize(mutatingAction("no-active-task")).kind, "deny");
});

test("the sentinel id is reserved: no creation path can make the fail-closed deny an allow", () => {
  const application = interactiveApplication();
  const port = createTaskCommandPort(application);
  // Through the port...
  assert.throws(() => port.createTask({ id: NO_ACTIVE_TASK_ID, title: "hostile" }), /reserved/);
  // ...and through the application seam every other creation path uses
  // (web /api/tasks, hub flows, direct callers).
  assert.throws(
    () => application.addTask({ id: NO_ACTIVE_TASK_ID, title: "hostile", dependencies: [], requiredEvidence: [] }),
    /reserved/,
  );
});

test("kernel transition rejections surface through the port — never a silent no-op", () => {
  const application = interactiveApplication();
  const port = createTaskCommandPort(application);
  const gated = port.createTask({
    title: "requires proof",
    requiredEvidence: [{ authority: "environment", subject: "proof" }],
  });
  port.activateTask(gated);
  // No evidence recorded: the kernel must reject VERIFIED and the port must
  // throw the rejection, not swallow it.
  assert.throws(() => port.completeTask(gated, []), /EVIDENCE_REQUIRED|rejected/);
  // The task stays VERIFYING — the failure is state-visible, not narrated away.
  assert.equal(application.snapshot().tasks.find((entry) => entry.id === gated)?.state, "VERIFYING");
  // With the required evidence supplied the same call verifies.
  port.completeTask(gated, [{ subject: "proof" }]);
  assert.equal(application.snapshot().tasks.find((entry) => entry.id === gated)?.state, "VERIFIED");
});

test("the ACP TUI boot initializes the active-task pointer the lazy correlation reads", () => {
  // acp-tui is a top-level script (side effects at import), so the boot
  // contract is pinned at the source level like the other launcher
  // contracts (test/tui-cli.test.ts pattern): the lazy correlation reads
  // application.activeTaskId(), which throws unless the pointer exists —
  // the launcher MUST call startInteractiveTask before composing the runtime.
  const source = readFileSync(join(process.cwd(), "src", "cli", "acp-tui.tsx"), "utf8");
  assert.match(source, /application\.startInteractiveTask\(\)/, "acp-tui must initialize the active-task pointer");
  assert.match(source, /activeTaskCorrelation\(application\)/, "acp-tui must compose the lazy correlation");
});

// ── Interactive-shaped: the ACP driver correlates with the active task ─────

function fakeAgent(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["test/fixtures/fake-acp-agent.mjs", "permission"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("an interactive session follows the active task: proposals re-correlate mid-session and blocked work fails closed", async () => {
  const application = interactiveApplication();
  const port = createTaskCommandPort(application);
  const seen: ProposedToolAction[] = [];
  const authorize = (action: ProposedToolAction): PolicyDecision => {
    seen.push(action);
    // The sentinel correlation (no IN_PROGRESS task) is the blocked-work deny.
    return action.taskId === NO_ACTIVE_TASK_ID
      ? { kind: "deny", code: "UNKNOWN_TASK", reason: "no active task" }
      : { kind: "allow" };
  };
  const child = fakeAgent();
  const driver = new AcpSessionDriver({
    child,
    authorize,
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: activeTaskCorrelation(application),
  });
  const session = new WorkflowCodingSession(driver);
  try {
    // Turn 1: the session task (SEED) is active and the proposal correlates.
    await session.submit("first prompt");
    assert.equal(seen[0]?.taskId, taskId("SEED"));

    // Operator-confirmed decomposition mid-session: activate a decomposed
    // canonical task through the port.
    const decomposed = port.createTask({ title: "Decomposed subtask" });
    port.activateTask(decomposed);
    assert.equal(port.activeTaskId(), decomposed);

    // Turn 2: the very same driver/session now correlates with the NEW task.
    await session.submit("second prompt");
    assert.equal(seen[1]?.taskId, decomposed, "lazy correlation follows the active task mid-session");

    // Complete the decomposed task: nothing is IN_PROGRESS any more.
    port.completeTask(decomposed, []);
    assert.equal(port.activeTaskId(), undefined);

    // Turn 3: blocked work cannot mutate — the correlation fails closed and
    // no proposal authorizes against a live task.
    await session.submit("third prompt");
    assert.equal(seen[2]?.taskId, NO_ACTIVE_TASK_ID, "no active task correlates with the sentinel");
    assert.equal(seen.filter((action) => action.taskId === decomposed).length, 1, "no stale-task proposal after completion");
  } finally {
    await driver.dispose();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
});

test("a fixed task correlation keeps hub-run semantics unchanged", async () => {
  const seen: ProposedToolAction[] = [];
  const child = fakeAgent();
  const driver = new AcpSessionDriver({
    child,
    authorize: (action) => {
      seen.push(action);
      return { kind: "allow" };
    },
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: taskId("run:fixed"),
  });
  const session = new WorkflowCodingSession(driver);
  try {
    await session.submit("run prompt");
    await session.submit("another run prompt");
  } finally {
    await driver.dispose();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  assert.ok(seen.length >= 2);
  for (const action of seen) {
    assert.equal(action.taskId, taskId("run:fixed"), "a fixed id stays stamped for hub-run runtimes");
  }
});

// Advisory-only decomposition: the plan projection carries model-proposed
// entries with zero canonical effect (criterion 3's advisory half).

test("model-proposed plan entries stay advisory — no canonical task materializes without the port", async () => {
  const application = interactiveApplication();
  const before = application.snapshot().tasks.length;
  const child = spawn(process.execPath, ["test/fixtures/fake-acp-agent.mjs", "batch2"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const driver = new AcpSessionDriver({
    child,
    authorize: () => ({ kind: "allow" }),
    workspace: "/repo",
    workspaceSessionId: "workflow-session",
    taskId: activeTaskCorrelation(application),
  });
  const events: CodingSessionEvent[] = [];
  const session = new WorkflowCodingSession(driver);
  session.subscribe((event) => events.push(event));
  try {
    await session.submit("plan something");
  } finally {
    await driver.dispose();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  const plan = events.find((event) => event.type === "plan");
  assert.ok(plan !== undefined, "the agent's decomposition proposal arrives as an advisory plan event");
  assert.equal(application.snapshot().tasks.length, before, "the plan alone never creates canonical tasks");
});
