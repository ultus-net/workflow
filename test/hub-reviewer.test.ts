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
  parseReviewCoverage,
  parseReviewVerdict,
  createGitDiffSource,
  createGitStatusSource,
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

/**
 * Serves one fresh reviewer session per spawn, each answering with the next
 * message in order (W040 partitioned reviews run one isolated session per
 * unit plus one integration session).
 */
function stubSequenceReviewer(finalMessages: (string | Error)[]): {
  factory: ReviewerAgentSessionFactory;
  prompts: string[];
  disposed: number;
} {
  const prompts: string[] = [];
  let spawned = 0;
  let disposed = 0;
  const factory: ReviewerAgentSessionFactory = {
    async spawn() {
      const message = finalMessages[Math.min(spawned, finalMessages.length - 1)]!;
      spawned += 1;
      return {
        async review(prompt: string) {
          prompts.push(prompt);
          if (message instanceof Error) throw message;
          return message;
        },
        async dispose() {
          disposed += 1;
        },
      };
    },
  };
  return { factory, prompts, get disposed() { return disposed; } };
}

function stubStatus(status: string | Error) {
  return async () => {
    if (status instanceof Error) throw status;
    return status;
  };
}

async function runnerWith(
  t: TestContext,
  reviewer: { factory: ReviewerAgentSessionFactory; prompts: string[]; disposed: number },
  diff: string | Error = "diff --git a/x b/x",
  status?: string | Error,
) {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const runner = new HubReviewerRunner({
    controller: base.controller,
    diffSource: stubDiff(diff),
    ...(status === undefined ? {} : { statusSource: stubStatus(status) }),
    spawnReviewer: reviewer.factory,
  });
  return { ...base, runner };
}

test("parseReviewVerdict accepts the rubric-mandated verdict tokens", () => {
  assert.deepEqual(parseReviewVerdict(APPROVED_MESSAGE), {
    verdict: "approved",
    summary: APPROVED_MESSAGE,
    coveredPaths: [],
  });
  assert.deepEqual(parseReviewVerdict(CHANGES_MESSAGE), {
    verdict: "changes_requested",
    summary: CHANGES_MESSAGE,
    coveredPaths: [],
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

test("reviewer session failures fail closed, dispose the session, and close the reviewer run", async (t) => {
  const reviewer = stubReviewer(new Error("reviewer agent crashed"));
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-7", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(runner.reviewRun({ runId: "author-7", workspace }), /reviewer agent crashed/);
  assert.equal(reviewer.disposed, 1);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS");
  // The begun reviewer run must not leak a lingering IN_PROGRESS task.
  const reviewerTasks = application.snapshot().tasks.filter((task) => task.title === "Hub reviewer run");
  assert.equal(reviewerTasks.length, 1);
  assert.equal(reviewerTasks[0]?.state, "FAILED");
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

test("createGitStatusSource runs the contained git status and fails closed on non-zero exit", async () => {
  const calls: { command: string; cwd: string }[] = [];
  const source = createGitStatusSource(async (command, cwd) => {
    calls.push({ command, cwd });
    return "M  src/a.ts\0";
  });
  assert.equal(await source("/ws"), "M  src/a.ts\0");
  assert.deepEqual(calls, [{ command: "git status --porcelain=v1 -z --untracked-files=all", cwd: "/ws" }]);

  const failing = createGitStatusSource(async () => {
    throw new Error("exit 128");
  });
  await assert.rejects(failing("/ws"), /exit 128/);
});

test("parseReviewCoverage extracts paths from the last [COVERAGE] line only", () => {
  const message = "instructions mention [COVERAGE] path1, path2\n[APPROVE]\nsummary\n[COVERAGE] src/a.ts, src/b.ts ,\n";
  assert.deepEqual(parseReviewCoverage(message), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(parseReviewCoverage("no coverage line at all"), []);
  assert.deepEqual(parseReviewCoverage("[COVERAGE]"), []);
});

// W039: with a status source wired, review scope is the deterministic
// manifest and approvals are gated on complete manifest coverage.
const STATUS_TWO = "M  src/a.ts\0?? src/b.ts\0";

test("an approved verdict whose [COVERAGE] line covers the manifest records", async (t) => {
  const reviewer = stubReviewer(`[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/a.ts, src/b.ts`);
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_TWO);
  await controller.begin({ runId: "author-8", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-8", workspace });

  assert.equal(result.verdict, "approved");
  assert.equal(result.recorded, true);
  assert.equal(result.parseFailure, undefined);
  const prompt = reviewer.prompts[0]!;
  assert.ok(prompt.includes("### Review Coverage Manifest (deterministic scope):"));
  assert.ok(prompt.includes("- src/a.ts - modified [obligations: general]"));
  assert.ok(prompt.includes("- src/b.ts - untracked [obligations: general]"));
  assert.ok(prompt.includes("[COVERAGE]"));
});

test("an approved verdict that omits a manifest path fails closed as incomplete coverage", async (t) => {
  const reviewer = stubReviewer(`[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/a.ts`);
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_TWO);
  await controller.begin({ runId: "author-9", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-9", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.match(result.parseFailure ?? "", /coverage is incomplete/);
  assert.match(result.parseFailure ?? "", /src\/b\.ts/);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS");
});

test("an approved verdict without a [COVERAGE] line fails closed when a manifest is wired", async (t) => {
  const reviewer = stubReviewer(APPROVED_MESSAGE);
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_TWO);
  await controller.begin({ runId: "author-10", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-10", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.match(result.parseFailure ?? "", /coverage is incomplete/);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS");
});

test("a changes_requested verdict is not gated on manifest coverage", async (t) => {
  const reviewer = stubReviewer(CHANGES_MESSAGE);
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_TWO);
  await controller.begin({ runId: "author-11", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-11", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.equal(result.parseFailure, undefined);
});

test("status sourcing failures fail closed before any review prompt", async (t) => {
  const reviewer = stubReviewer(APPROVED_MESSAGE);
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", new Error("git status failed"));
  await controller.begin({ runId: "author-12", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(runner.reviewRun({ runId: "author-12", workspace }), /git status failed/);
  assert.equal(reviewer.prompts.length, 0);
});

test("without a status source the manifest gate stays dormant (backward-compatible composition)", async (t) => {
  const reviewer = stubReviewer(APPROVED_MESSAGE);
  const { controller, workspace, runner } = await runnerWith(t, reviewer);
  await controller.begin({ runId: "author-13", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-13", workspace });

  assert.equal(result.verdict, "approved");
  assert.equal(result.recorded, true);
  assert.ok(!reviewer.prompts[0]!.includes("Review Coverage Manifest"));
});

// W040: multi-component scope is reviewed per unit with fresh isolated
// sessions carrying only that unit's focused rules, plus an integration
// review; every unit must approve with complete [COVERAGE].
const STATUS_MULTI = "M  src/integrations/hub-reviewer.ts\0M  test/hub-reviewer.test.ts\0M  src/ui/web.ts\0";
const UNIT_AXES = `${AXES_SUMMARY}`;

test("a multi-unit scope runs one isolated reviewer per unit plus integration, all approving", async (t) => {
  const reviewer = stubSequenceReviewer([
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/integrations/hub-reviewer.ts, test/hub-reviewer.test.ts`,
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/ui/web.ts`,
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/integrations, src/ui`,
  ]);
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI);
  await controller.begin({ runId: "author-14", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-14", workspace });

  assert.equal(result.verdict, "approved");
  assert.equal(result.recorded, true);
  assert.equal(result.parseFailure, undefined);
  // Unit 1: implementation + its paired test, focused rules, [COVERAGE] of its paths.
  assert.ok(reviewer.prompts[0]!.includes("Review unit `src/integrations` — 2 file(s)"));
  assert.ok(reviewer.prompts[0]!.includes("- test/hub-reviewer.test.ts"));
  assert.ok(reviewer.prompts[0]!.includes("Focused rules for this unit:"));
  // Unit 2 carries ui rules, not authority or security rules.
  assert.ok(reviewer.prompts[1]!.includes("Review unit `src/ui` — 1 file(s)"));
  assert.ok(reviewer.prompts[1]!.includes("cannot bypass kernel decisions"));
  assert.ok(!reviewer.prompts[1]!.includes("legal kernel transitions"));
  // Integration lists every unit id and requires [COVERAGE] of the ids.
  assert.ok(reviewer.prompts[2]!.includes("Integration review — cross-unit behavior for 2 units:"));
  assert.ok(reviewer.prompts[2]!.includes("- src/integrations ("));
  assert.ok(reviewer.prompts[2]!.includes("- src/ui ("));
  assert.equal(reviewer.disposed, 3);
  assert.ok(result.summary.includes("Partitioned review approved across 2 unit(s) + integration"));
  assert.ok(result.summary.includes("Units: src/integrations, src/ui"));
  // The run can verify through the ordinary finish path.
  await controller.finish({ runId: "author-14", outcome: "verified" });
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
});

test("one unit's rejection fails the whole partitioned review closed", async (t) => {
  const reviewer = stubSequenceReviewer([
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/integrations/hub-reviewer.ts, test/hub-reviewer.test.ts`,
    `[REQUEST_CHANGES]\nfindings: P1 ui regression in test integrity.`,
  ]);
  const { controller, workspace, application, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI);
  await controller.begin({ runId: "author-15", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-15", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.match(result.parseFailure ?? "", /unit src\/ui: changes requested by unit review/);
  // The rejecting unit stops the review: no integration session is spawned.
  assert.equal(reviewer.prompts.length, 2);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS");
});

test("a unit approval with incomplete [COVERAGE] fails closed naming the unit and the path", async (t) => {
  const reviewer = stubSequenceReviewer([
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/integrations/hub-reviewer.ts`,
  ]);
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI);
  await controller.begin({ runId: "author-16", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-16", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.match(result.parseFailure ?? "", /unit src\/integrations: approved review coverage is incomplete/);
  assert.match(result.parseFailure ?? "", /test\/hub-reviewer\.test\.ts/);
});

test("an integration approval that omits a unit id fails closed", async (t) => {
  const reviewer = stubSequenceReviewer([
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/integrations/hub-reviewer.ts, test/hub-reviewer.test.ts`,
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/ui/web.ts`,
    `[APPROVE]\n${UNIT_AXES}\n[COVERAGE] src/integrations`,
  ]);
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI);
  await controller.begin({ runId: "author-17", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-17", workspace });

  assert.equal(result.verdict, "changes_requested");
  assert.equal(result.recorded, false);
  assert.match(result.parseFailure ?? "", /unit integration: approved review coverage is incomplete/);
  assert.match(result.parseFailure ?? "", /src\/ui/);
});

test("a single-component scope keeps the single-session flow (no integration review)", async (t) => {
  const reviewer = stubReviewer(`[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/a.ts, src/b.ts`);
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_TWO);
  await controller.begin({ runId: "author-18", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-18", workspace });

  assert.equal(result.verdict, "approved");
  assert.equal(result.recorded, true);
  assert.equal(reviewer.prompts.length, 1);
  assert.ok(reviewer.prompts[0]!.includes("### Review Coverage Manifest (deterministic scope):"));
  assert.ok(!reviewer.prompts[0]!.includes("Integration review"));
});
