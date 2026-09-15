import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import { createReviewerFactory, createRunTestRunner } from "../src/integrations/hub-run-gates.js";

/**
 * Production wiring for the hub-owned run gates (plan Tasks A2/D1): the
 * reviewer factory composes HubReviewerRunner over a runtime session
 * (contained ACP in production, stubbed here), and the test runner executes
 * the configured verification command through a contained shell (stubbed
 * here). Composition-level tests; the real contained composition is covered
 * by the gated probes.
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];
const AXES_SUMMARY = "test integrity: real assertions. task completeness: done. cleanliness: no dead code.";

function setup() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const workspace = mkdtempSync(join(tmpdir(), "wf-run-gates-ws-"));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
  return { graph, application, workspace };
}

test("createRunTestRunner executes the configured command in the run workspace", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  const runner = createRunTestRunner({
    command: "npm test",
    shell: async (command, cwd) => {
      calls.push({ command, cwd });
      return "all green";
    },
  });

  const passed = await runner({ runId: "author-1", workspace: "/ws", subject: "test:/ws" });
  assert.deepEqual(passed, { passed: true, output: "all green" });
  assert.deepEqual(calls, [{ command: "npm test", cwd: "/ws" }]);
});

test("createRunTestRunner reports failure with the command output and fails closed without a workspace", async () => {
  const runner = createRunTestRunner({
    command: "npm test",
    shell: async () => {
      throw Object.assign(new Error("1 failing: expected 3, got 4"), { exitCode: 1 });
    },
  });

  const failed = await runner({ runId: "author-2", workspace: "/ws", subject: "test:/ws" });
  assert.equal(failed.passed, false);
  assert.match(failed.output, /expected 3, got 4/);

  const workspaceless = await runner({ runId: "author-3", workspace: undefined, subject: "test:author-3" });
  assert.equal(workspaceless.passed, false);
  assert.match(workspaceless.output, /workspace/);
});

test("createReviewerFactory drives a full registry review through the runtime session", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const prompts: string[] = [];
  let disposed = 0;
  const factory = createReviewerFactory({
    shell: async () => "diff --git a/x b/x",
    createRuntime: async () => ({
      async submit(prompt: string) {
        prompts.push(prompt);
      },
      snapshot: () => ({ state: "completed", result: `[APPROVE]\n${AXES_SUMMARY}` }),
      async dispose() {
        disposed += 1;
      },
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-4", title: "Author run", workspace: base.workspace, requiresReview: true });

  await registry.controller.finish({ runId: "author-4", outcome: "verified" });

  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes("# Secondary Review Agent Quality Gate"));
  assert.ok(prompts[0]!.includes("diff --git a/x b/x"));
  assert.equal(disposed, 1);
  const runTask = base.application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
});

test("createReviewerFactory surfaces reviewer runtime failures fail-closed", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const factory = createReviewerFactory({
    shell: async () => "diff --git a/x b/x",
    createRuntime: async () => ({
      async submit() {},
      snapshot: () => ({ state: "failed", reason: "agent crashed" }),
      async dispose() {},
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-5", title: "Author run", workspace: base.workspace, requiresReview: true });

  await assert.rejects(registry.controller.finish({ runId: "author-5", outcome: "verified" }), /did not complete/);
  const runTask = base.application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFYING");
});
