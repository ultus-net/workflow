import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { evidenceId, observationId, taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import { createReviewerFactory, createRunTestRunner, reviewerRunTaskId } from "../src/integrations/hub-run-gates.js";

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
    // The production shell executes the real command; this stub answers both
    // the diff and the W039 status sourcing through the same seam.
    shell: async (command) => (command.startsWith("git status") ? "M  src/thing.ts\0" : "diff --git a/x b/x"),
    createRuntime: async () => ({
      async submit(prompt: string) {
        prompts.push(prompt);
      },
      snapshot: () => ({
        state: "completed",
        result: `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/thing.ts`,
      }),
      async dispose() {
        disposed += 1;
      },
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({
    runId: "author-4",
    title: "Author run",
    workspace: base.workspace,
    requiresReview: true,
    taskPrompt: "the scheduled ask",
  });

  await registry.controller.finish({ runId: "author-4", outcome: "verified" });

  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes("# Secondary Review Agent Quality Gate"));
  assert.ok(prompts[0]!.includes("diff --git a/x b/x"));
  assert.ok(prompts[0]!.includes("### Review Coverage Manifest (deterministic scope):"));
  assert.ok(prompts[0]!.includes("- src/thing.ts - modified [obligations: general]"));
  // W041: the run's declared ask flows registry -> reviewer into the rubric,
  // so the provenance fingerprint binds a real prompt, not always the empty one.
  assert.ok(prompts[0]!.includes("the scheduled ask"));
  assert.equal(disposed, 1);
  const runTask = base.application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
});

test("W072 I-5: the registry derives the run task's ledger and threads it into the reviewer prompt", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const prompts: string[] = [];
  const factory = createReviewerFactory({
    shell: async (command) => (command.startsWith("git status") ? "M  src/thing.ts\0" : "diff --git a/x b/x"),
    createRuntime: async () => ({
      async submit(prompt: string) {
        prompts.push(prompt);
      },
      snapshot: () => ({ state: "completed", result: `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/thing.ts` }),
      async dispose() {},
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-ledger", title: "Author run", workspace: base.workspace, requiresReview: true });
  // The registry renders the RUN task's canonical steps (shared graph). I-4
  // blocks promotion while a step is open, so the ledger here is terminal:
  // one COMPLETED step, completed through the kernel's evidence gate.
  const [ledgerStep] = base.application.defineTaskSteps(taskId("run:author-ledger"), [
    { content: "ship the thing", requiredEvidence: [{ authority: "environment", subject: "step:run:author-ledger-step-1" }] },
  ]);
  base.application.startTaskStep(ledgerStep!.id);
  base.application.recordEvidence({
    id: evidenceId("e-ledger"),
    observationId: observationId("o-ledger"),
    authority: "environment",
    subject: "step:run:author-ledger-step-1",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: base.application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
  base.application.completeTaskStep(ledgerStep!.id);

  await registry.controller.finish({ runId: "author-ledger", outcome: "verified" });

  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes("### Step Ledger Under Audit (deterministic kernel state):"));
  assert.ok(prompts[0]!.includes("ship the thing"));
  assert.ok(prompts[0]!.includes("[COMPLETED]"), "the kernel state is rendered verbatim, not inferred");
});

test("W072 I-5: a step-less run's reviewer prompt carries no ledger section (byte-identical path)", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const prompts: string[] = [];
  const factory = createReviewerFactory({
    shell: async (command) => (command.startsWith("git status") ? "M  src/thing.ts\0" : "diff --git a/x b/x"),
    createRuntime: async () => ({
      async submit(prompt: string) {
        prompts.push(prompt);
      },
      snapshot: () => ({ state: "completed", result: `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/thing.ts` }),
      async dispose() {},
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-noledger", title: "Author run", workspace: base.workspace, requiresReview: true });

  await registry.controller.finish({ runId: "author-noledger", outcome: "verified" });

  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0]!.includes("Step Ledger Under Audit"));
  assert.ok(!prompts[0]!.includes("No step ledger is attached"));
});

test("createReviewerFactory surfaces reviewer runtime failures fail-closed", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const factory = createReviewerFactory({
    shell: async (command) => (command.startsWith("git status") ? "" : "diff --git a/x b/x"),
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

// #134 round-2: the adapter must FORWARD the runtime's endTask — the
// round-1 review's P0 was exactly this layer dropping it, leaving the
// hub-reviewer task IN_PROGRESS in production while every stub-composed
// runner test stayed green. These pins compose the FULL production path
// (createReviewerFactory's spawn literal → HubReviewerRunner) with a
// recording runtime.
test("#134: the adapter forwards endTask — a completed review closes the session's kernel task through the PRODUCTION composition", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const outcomes: Array<"completed" | "failed"> = [];
  const factory = createReviewerFactory({
    shell: async (command) => (command.startsWith("git status") ? "M  src/thing.ts\0" : "diff --git a/x b/x"),
    createRuntime: async () => ({
      async submit() {},
      snapshot: () => ({ state: "completed", result: `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/thing.ts` }),
      async dispose() {},
      endTask(outcome: "completed" | "failed") {
        outcomes.push(outcome);
      },
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-6", title: "Author run", workspace: base.workspace, requiresReview: true });
  await registry.controller.finish({ runId: "author-6", outcome: "verified" });
  assert.deepEqual(outcomes, ["completed"], "the adapter forwarded endTask — the kernel task closed on review completion");
});

test("#134: the adapter forwards endTask on the failure path too (a throwing review fails the session's kernel task)", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const outcomes: Array<"completed" | "failed"> = [];
  const factory = createReviewerFactory({
    shell: async (command) => (command.startsWith("git status") ? "" : "diff --git a/x b/x"),
    createRuntime: async () => ({
      async submit() {},
      snapshot: () => ({ state: "failed", reason: "agent crashed" }),
      async dispose() {},
      endTask(outcome: "completed" | "failed") {
        outcomes.push(outcome);
      },
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-7", title: "Author run", workspace: base.workspace, requiresReview: true });
  await assert.rejects(registry.controller.finish({ runId: "author-7", outcome: "verified" }), /did not complete/);
  assert.deepEqual(outcomes, ["failed"], "the adapter forwarded endTask — the kernel task failed on the review's error path");
});

// W111 (issue #283): the reviewer lane is the remaining registry-holding
// composition root that composes an ACP runtime. The factory now forwards the
// registry's per-task journal writer into the reviewer runtime, so a COMPLETED
// reviewer turn publishes its boundary delta into the one taskUsage journal the
// scheduler and RSI lanes write. Before the seam, the writer never reaches the
// runtime and a completed review records nothing.
test("W111 (issue #283): the reviewer factory forwards the registry's per-task journal writer into the reviewer runtime", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const factory = createReviewerFactory({
    shell: async (command) => (command.startsWith("git status") ? "M  src/thing.ts\0" : "diff --git a/x b/x"),
    createRuntime: async ({ recordTaskUsage }) => ({
      async submit() {
        // Emulate the ACP runtime's completed-turn boundary: the sink the
        // factory forwarded reaches the registry's journal writer. The task id
        // here is arbitrary (the stub's own) — the writer is a faithful
        // pass-through; the binding to the run task is pinned by the next test.
        recordTaskUsage({
          taskId: "hub-reviewer:test",
          requests: 1,
          promptTokens: 5,
          completionTokens: 2,
          totalTokens: 7,
          costUsd: 0.001,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        });
      },
      snapshot: () => ({ state: "completed", result: `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/thing.ts` }),
      async dispose() {},
    }),
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-8", title: "Author run", workspace: base.workspace, requiresReview: true });
  await registry.controller.finish({ runId: "author-8", outcome: "verified" });

  const recorded = registry.taskUsage();
  assert.equal(recorded.length, 1, "a completed reviewer turn publishes exactly one per-task delta through the forwarded journal writer");
  assert.equal(recorded[0]?.taskId, "hub-reviewer:test");
  assert.equal(recorded[0]?.totalTokens, 7);
});

// W111 (issue #283): the residual this fragment closes was the reviewer delta's
// ATTRIBUTION — recorded, but under the phantom reviewer SESSION task
// (`hub-reviewer:<id>`), which the per-task view (joining `run:<id>`) never
// rendered. The factory now forwards the reviewer RUN id and the production
// composition binds the runtime's correlation to `reviewerRunTaskId(id)` =
// `run:<reviewerRunId>`. This pin composes the FULL production path
// (createReviewerFactory's spawn literal → HubReviewerRunner) and asserts the
// run-bound id, not the session id.
test("W111 (issue #283): the reviewer factory forwards the reviewer RUN id, and the reviewer delta publishes under run:<reviewerRunId>", async (t) => {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  let capturedReviewerRunId: string | undefined;
  const factory = createReviewerFactory({
    shell: async (command) => (command.startsWith("git status") ? "M  src/thing.ts\0" : "diff --git a/x b/x"),
    createRuntime: async ({ recordTaskUsage, reviewerRunId }) => {
      capturedReviewerRunId = reviewerRunId;
      // The production composition passes reviewerRunTaskId(reviewerRunId) as
      // the ACP driver's task correlation; the driver reads it at the
      // completed-turn boundary. Emulate that exact id.
      return {
        async submit() {
          recordTaskUsage({
            taskId: reviewerRunTaskId(reviewerRunId),
            requests: 1,
            promptTokens: 5,
            completionTokens: 2,
            totalTokens: 7,
            costUsd: 0.001,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          });
        },
        snapshot: () => ({ state: "completed", result: `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/thing.ts` }),
        async dispose() {},
      };
    },
  });
  const registry = createRunRegistry(base.application, base.graph, { reviewer: factory });
  await registry.controller.begin({ runId: "author-9", title: "Author run", workspace: base.workspace, requiresReview: true });
  await registry.controller.finish({ runId: "author-9", outcome: "verified" });

  assert.ok(capturedReviewerRunId !== undefined, "the factory forwarded the reviewer run id into createRuntime");
  assert.equal(reviewerRunTaskId(capturedReviewerRunId), "run:" + capturedReviewerRunId, "the run task id is the canonical run:<id> the view joins");
  const recorded = registry.taskUsage();
  assert.equal(recorded.length, 1, "a completed reviewer turn publishes exactly one per-task delta");
  assert.equal(recorded[0]?.taskId, "run:" + capturedReviewerRunId, "the delta publishes under run:<reviewerRunId>, never the phantom hub-reviewer:<id> session task");
});
