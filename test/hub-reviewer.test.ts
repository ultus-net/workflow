import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import {
  HubReviewerRunner,
  parseReviewVerdict,
  createGitDiffSource,
  type ReviewerAgentSessionFactory,
} from "../src/integrations/hub-reviewer.js";

/**
 * The hub-owned reviewer runner (plan Task A1): the hub spawns its own
 * reviewer run (distinct runId), sources the diff, prompts a reviewer agent
 * with the rubric, and records the verdict through the run controller —
 * fail closed on unparseable or rubber-stamped verdicts.
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];

const AXES_SUMMARY = "test integrity: real assertions. task completeness: done. cleanliness: no dead code.";
const APPROVED_MESSAGE = `[APPROVE]\n${AXES_SUMMARY}`;
const CHANGES_MESSAGE = `[REQUEST_CHANGES]\nfindings: P2 edge case in test integrity; task completeness gap.`;

function setup() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const workspace = mkdtempSync(join(tmpdir(), "wf-hub-reviewer-ws-"));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
  const registry = createRunRegistry(application, graph);
  return { graph, workspace, application, controller: registry.controller };
}

function stubReviewer(finalMessage: string | Error): {
  factory: ReviewerAgentSessionFactory;
  prompts: string[];
  disposed: number;
} {
  const prompts: string[] = [];
  let disposed = 0;
  const factory: ReviewerAgentSessionFactory = {
    async spawn() {
      return {
        async review(prompt: string) {
          prompts.push(prompt);
          if (finalMessage instanceof Error) throw finalMessage;
          return finalMessage;
        },
        async dispose() {
          disposed += 1;
        },
      };
    },
  };
  return {
    factory,
    prompts,
    get disposed() {
      return disposed;
    },
  };
}

function stubDiff(diff: string | Error) {
  return async () => {
    if (diff instanceof Error) throw diff;
    return diff;
  };
}

async function runnerWith(t: TestContext, reviewer: ReturnType<typeof stubReviewer>, diff: string | Error = "diff --git a/x b/x") {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const runner = new HubReviewerRunner({
    controller: base.controller,
    diffSource: stubDiff(diff),
    spawnReviewer: reviewer.factory,
  });
  return { ...base, runner };
}

test("parseReviewVerdict accepts the rubric-mandated verdict tokens", () => {
  assert.deepEqual(parseReviewVerdict(APPROVED_MESSAGE), {
    verdict: "approved",
    summary: APPROVED_MESSAGE,
  });
  assert.deepEqual(parseReviewVerdict(CHANGES_MESSAGE), {
    verdict: "changes_requested",
    summary: CHANGES_MESSAGE,
  });
});

test("parseReviewVerdict fails closed on missing or ambiguous tokens", () => {
  assert.equal(parseReviewVerdict("looks good to me"), undefined);
  assert.equal(parseReviewVerdict(""), undefined);
  assert.equal(parseReviewVerdict(`[APPROVE] and also [REQUEST_CHANGES]`), undefined);
});

test("an approved reviewer verdict records reviewer evidence for the run", async (t) => {
  const reviewer = stubReviewer(APPROVED_MESSAGE);
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-1", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-1", workspace, taskPrompt: "fix the bug" });

  assert.equal(result.verdict, "approved");
  assert.equal(result.recorded, true);
  assert.equal(result.parseFailure, undefined);
  // The reviewer was prompted with the rubric and the sourced diff.
  assert.ok(reviewer.prompts[0]!.includes("# Secondary Review Agent Quality Gate"));
  assert.ok(reviewer.prompts[0]!.includes("diff --git a/x b/x"));
  assert.ok(reviewer.prompts[0]!.includes("fix the bug"));
  assert.equal(reviewer.disposed, 1);
  // The run can now verify through the ordinary finish path.
  await controller.finish({ runId: "author-1", outcome: "verified" });
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
});

test("the reviewer run is distinct from the subject run and registered before review", async (t) => {
  const reviewer = stubReviewer(APPROVED_MESSAGE);
  const { controller, workspace, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-2", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-2", workspace });

  assert.ok(result.reviewerRunId.length > 0);
  assert.notEqual(result.reviewerRunId, "author-2");
  assert.match(result.reviewerRunId, /^schedule:hub-reviewer-/);
});

test("an unparseable reviewer message fails closed: never approved, nothing recorded", async (t) => {
  const reviewer = stubReviewer("I could not evaluate this change, sorry");
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-3", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-3", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.ok(result.parseFailure !== undefined);
  // The finish attempt reaches the gate and halts: never VERIFIED without
  // reviewer evidence (fail closed).
  await assert.rejects(controller.finish({ runId: "author-3", outcome: "verified" }));
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFYING");
});

test("an approved message whose summary lacks axis references fails closed (anti-rubber-stamp)", async (t) => {
  const reviewer = stubReviewer("[APPROVE] looks good to me");
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-4", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-4", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.match(result.parseFailure ?? "", /axes/);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS");
});

test("a changes_requested verdict is surfaced and records nothing", async (t) => {
  const reviewer = stubReviewer(CHANGES_MESSAGE);
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-5", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-5", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.equal(result.parseFailure, undefined);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS");
});

test("diff sourcing failures fail closed with no review recorded", async (t) => {
  const reviewer = stubReviewer(APPROVED_MESSAGE);
  const { controller, workspace, runner } = await runnerWith(t, reviewer, new Error("git diff failed"));
  await controller.begin({ runId: "author-6", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(runner.reviewRun({ runId: "author-6", workspace }), /git diff failed/);
  assert.equal(reviewer.prompts.length, 0);
});

test("reviewer session failures fail closed and still dispose the session", async (t) => {
  const reviewer = stubReviewer(new Error("reviewer agent crashed"));
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-7", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(runner.reviewRun({ runId: "author-7", workspace }), /reviewer agent crashed/);
  assert.equal(reviewer.disposed, 1);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS");
});

test("createGitDiffSource runs a contained git diff and fails closed on non-zero exit", async () => {
  const calls: { command: string; cwd: string }[] = [];
  const source = createGitDiffSource(async (command, cwd) => {
    calls.push({ command, cwd });
    return "diff --git a/y b/y";
  });
  assert.equal(await source("/ws"), "diff --git a/y b/y");
  assert.deepEqual(calls, [{ command: "git diff HEAD", cwd: "/ws" }]);

  const failing = createGitDiffSource(async () => {
    throw new Error("exit 128");
  });
  await assert.rejects(failing("/ws"), /exit 128/);
});
