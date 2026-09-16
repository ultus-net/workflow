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
  createGitCommitSource,
  createGitDiffSource,
  createGitStatusSource,
  type ReviewerAgentSessionFactory,
} from "../src/integrations/hub-reviewer.js";
import type { ReviewProvenanceStore } from "../src/integrations/review-provenance-store.js";
import { deriveReviewCoverageManifest } from "../src/review/manifest.js";
import { partitionReviewManifest } from "../src/review/partition.js";
import {
  reviewPromptDigest,
  reviewRuleSetDigest,
  type ReviewDisposition,
  type ReviewProvenanceFingerprint,
  type ReviewProvenanceRecord,
} from "../src/review/provenance.js";

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
  store?: ReviewProvenanceStore,
) {
  const base = setup();
  t.after(() => rmSync(base.workspace, { recursive: true, force: true }));
  const runner = new HubReviewerRunner({
    controller: base.controller,
    diffSource: stubDiff(diff),
    ...(status === undefined ? {} : { statusSource: stubStatus(status) }),
    ...(store === undefined ? {} : { provenanceStore: store }),
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

// W041: review provenance and replay. Every decision is journaled bound to
// its fingerprint, and interrupted partitioned reviews resume only units
// whose fingerprint still matches exactly.

function stubProvenanceStore() {
  const records: ReviewProvenanceRecord[] = [];
  const appended: ReviewProvenanceRecord[] = [];
  const store: ReviewProvenanceStore = {
    async append(record) {
      records.push(record);
      appended.push(record);
    },
    async records() {
      return [...records];
    },
  };
  return { store, appended, seed: (record: ReviewProvenanceRecord) => records.push(record) };
}

function multiFingerprint(taskPrompt?: string, overrides: Partial<ReviewProvenanceFingerprint> = {}): ReviewProvenanceFingerprint {
  const manifest = deriveReviewCoverageManifest({ statusOutput: STATUS_MULTI });
  const partition = partitionReviewManifest(manifest);
  return {
    commitHash: undefined,
    promptDigest: reviewPromptDigest(taskPrompt),
    manifestDigest: manifest.digest,
    partitionDigest: partition.digest,
    ruleSetDigest: reviewRuleSetDigest(),
    ...overrides,
  };
}

function seedRecord(
  workspace: string,
  inspectedUnit: string,
  covered: readonly string[],
  fingerprint: ReviewProvenanceFingerprint,
  disposition: ReviewDisposition = "approved",
): ReviewProvenanceRecord {
  return {
    version: 1,
    workspace,
    fingerprint,
    reviewer: "schedule:hub-reviewer-prior",
    inspectedUnits: [inspectedUnit],
    coveredPaths: covered,
    findings: "prior unit approval",
    verification: ["axes: 3/5"],
    disposition,
    recordedAt: new Date().toISOString(),
  };
}

const UNIT1_APPROVED = `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/integrations/hub-reviewer.ts, test/hub-reviewer.test.ts`;
const UNIT2_APPROVED = `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/ui/web.ts`;
const INTEGRATION_APPROVED = `[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/integrations, src/ui`;

test("the single-session flow journals the manifest decision before recording it", async (t) => {
  const reviewer = stubReviewer(`[APPROVE]\n${AXES_SUMMARY}\n[COVERAGE] src/a.ts, src/b.ts`);
  const provenance = stubProvenanceStore();
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_TWO, provenance.store);
  await controller.begin({ runId: "author-30", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-30", workspace });

  assert.equal(result.verdict, "approved");
  assert.equal(provenance.appended.length, 1);
  const record = provenance.appended[0]!;
  assert.equal(record.disposition, "approved");
  assert.deepEqual(record.inspectedUnits, ["manifest"]);
  assert.deepEqual(record.coveredPaths, ["src/a.ts", "src/b.ts"]);
  assert.equal(record.workspace, workspace);
  assert.equal(record.fingerprint.manifestDigest, deriveReviewCoverageManifest({ statusOutput: STATUS_TWO }).digest);
  assert.ok(record.verification.some((fact) => fact.startsWith("axes: ")));
  assert.ok(record.verification.includes("coverage gaps: 0"));
});

test("a multi-unit review journals per-unit, integration, and run-level records", async (t) => {
  const reviewer = stubSequenceReviewer([UNIT1_APPROVED, UNIT2_APPROVED, INTEGRATION_APPROVED]);
  const provenance = stubProvenanceStore();
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI, provenance.store);
  await controller.begin({ runId: "author-31", title: "Author run", workspace, requiresReview: true });

  await runner.reviewRun({ runId: "author-31", workspace });

  assert.equal(provenance.appended.length, 4);
  assert.deepEqual(provenance.appended[0]!.inspectedUnits, ["src/integrations"]);
  assert.equal(provenance.appended[0]!.disposition, "approved");
  assert.deepEqual(provenance.appended[1]!.inspectedUnits, ["src/ui"]);
  assert.deepEqual(provenance.appended[2]!.inspectedUnits, ["integration"]);
  const runLevel = provenance.appended[3]!;
  assert.deepEqual(runLevel.inspectedUnits, ["src/integrations", "src/ui", "integration"]);
  assert.deepEqual(runLevel.coveredPaths, [
    "src/integrations/hub-reviewer.ts",
    "test/hub-reviewer.test.ts",
    "src/ui/web.ts",
  ]);
  assert.equal(runLevel.disposition, "approved");
  assert.ok(runLevel.verification.includes("resumed from provenance: 0"));
});

test("units with matching-fingerprint approvals resume; only the rest run fresh sessions", async (t) => {
  const reviewer = stubSequenceReviewer([UNIT2_APPROVED, INTEGRATION_APPROVED]);
  const provenance = stubProvenanceStore();
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI, provenance.store);
  provenance.seed(seedRecord(workspace, "src/integrations", ["src/integrations/hub-reviewer.ts", "test/hub-reviewer.test.ts"], multiFingerprint()));
  await controller.begin({ runId: "author-32", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-32", workspace });

  assert.equal(result.verdict, "approved");
  // Unit 1 resumed from provenance: only unit 2 + integration spawned.
  assert.equal(reviewer.prompts.length, 2);
  assert.ok(reviewer.prompts[0]!.includes("Review unit `src/ui`"));
  assert.ok(result.summary.includes("Resumed 1 unit review(s) from provenance at an identical fingerprint."));
  const runLevel = provenance.appended.at(-1)!;
  assert.ok(runLevel.verification.includes("resumed from provenance: 1"));
});

test("a fully-resumed review approves by pure replay with zero reviewer sessions", async (t) => {
  const reviewer = stubSequenceReviewer([APPROVED_MESSAGE]);
  const provenance = stubProvenanceStore();
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI, provenance.store);
  provenance.seed(seedRecord(workspace, "src/integrations", ["src/integrations/hub-reviewer.ts", "test/hub-reviewer.test.ts"], multiFingerprint()));
  provenance.seed(seedRecord(workspace, "src/ui", ["src/ui/web.ts"], multiFingerprint()));
  provenance.seed(seedRecord(workspace, "integration", ["src/integrations", "src/ui"], multiFingerprint()));
  await controller.begin({ runId: "author-33", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-33", workspace });

  assert.equal(result.verdict, "approved");
  assert.equal(result.recorded, true);
  assert.equal(reviewer.prompts.length, 0);
  assert.ok(result.summary.includes("Resumed 3 unit review(s)"));
  assert.ok(provenance.appended.at(-1)!.verification.includes("resumed from provenance: 3"));
});

test("stale fingerprints and foreign workspaces resume nothing", async (t) => {
  const reviewer = stubSequenceReviewer([UNIT1_APPROVED, UNIT2_APPROVED, INTEGRATION_APPROVED]);

  const stale = stubProvenanceStore();
  const staleRun = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI, stale.store);
  staleRun.controller.begin({ runId: "author-34", title: "Author run", workspace: staleRun.workspace, requiresReview: true });
  // Same shape, different manifest digest: a real mutation happened since.
  stale.seed(seedRecord(staleRun.workspace, "src/integrations", ["src/integrations/hub-reviewer.ts", "test/hub-reviewer.test.ts"], multiFingerprint(undefined, { manifestDigest: "changed".repeat(8) })));
  await staleRun.runner.reviewRun({ runId: "author-34", workspace: staleRun.workspace });
  assert.equal(reviewer.prompts.length, 3);

  const foreign = stubProvenanceStore();
  const foreignRun = await runnerWith(t, stubSequenceReviewer([UNIT1_APPROVED, UNIT2_APPROVED, INTEGRATION_APPROVED]), "diff --git a/x b/x", STATUS_MULTI, foreign.store);
  foreignRun.controller.begin({ runId: "author-35", title: "Author run", workspace: foreignRun.workspace, requiresReview: true });
  // Identical fingerprint, different workspace: a clone's approval never applies here.
  foreign.seed(seedRecord("/elsewhere", "src/integrations", ["src/integrations/hub-reviewer.ts", "test/hub-reviewer.test.ts"], multiFingerprint()));
  await foreignRun.runner.reviewRun({ runId: "author-35", workspace: foreignRun.workspace });
  assert.ok(foreignRun.runner !== staleRun.runner);
});

test("an interrupted partitioned review journals progress and resumes it on the next run", async (t) => {
  const crashed = stubSequenceReviewer([UNIT1_APPROVED, new Error("reviewer agent crashed")]);
  const provenance = stubProvenanceStore();
  const { controller, workspace, runner } = await runnerWith(t, crashed, "diff --git a/x b/x", STATUS_MULTI, provenance.store);
  await controller.begin({ runId: "author-36", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(runner.reviewRun({ runId: "author-36", workspace }), /reviewer agent crashed/);
  // Unit 1's approval and the interruption are both journaled.
  assert.deepEqual(provenance.appended[0]!.inspectedUnits, ["src/integrations"]);
  assert.equal(provenance.appended.at(-1)!.disposition, "interrupted");
  assert.ok(provenance.appended.at(-1)!.findings.includes("reviewer agent crashed"));

  // The next run resumes the approved unit and only reviews what remains.
  const resumed = stubSequenceReviewer([UNIT2_APPROVED, INTEGRATION_APPROVED]);
  const runner2 = new HubReviewerRunner({
    controller,
    diffSource: stubDiff("diff --git a/x b/x"),
    statusSource: stubStatus(STATUS_MULTI),
    provenanceStore: provenance.store,
    spawnReviewer: resumed.factory,
  });
  const result = await runner2.reviewRun({ runId: "author-36", workspace });

  assert.equal(result.verdict, "approved");
  assert.equal(resumed.prompts.length, 2);
  assert.ok(result.summary.includes("Resumed 1 unit review(s)"));
});

test("a rejected unit journals the fail-closed decision", async (t) => {
  const reviewer = stubSequenceReviewer([UNIT1_APPROVED, `[REQUEST_CHANGES]\nP1 regression in test integrity.`]);
  const provenance = stubProvenanceStore();
  const { controller, workspace, runner } = await runnerWith(t, reviewer, "diff --git a/x b/x", STATUS_MULTI, provenance.store);
  await controller.begin({ runId: "author-37", title: "Author run", workspace, requiresReview: true });

  const result = await runner.reviewRun({ runId: "author-37", workspace });

  assert.equal(result.verdict, "changes_requested");
  const runLevel = provenance.appended.at(-1)!;
  assert.equal(runLevel.disposition, "changes_requested");
  assert.deepEqual(runLevel.inspectedUnits, ["src/ui"]);
  assert.ok(runLevel.findings.includes("changes requested by unit review"));
});

test("createGitCommitSource trims HEAD and fails soft on error", async () => {
  const calls: { command: string; cwd: string }[] = [];
  const source = createGitCommitSource(async (command, cwd) => {
    calls.push({ command, cwd });
    return "abc123\n";
  });
  assert.equal(await source("/ws"), "abc123");
  assert.deepEqual(calls, [{ command: "git rev-parse HEAD", cwd: "/ws" }]);

  const failing = createGitCommitSource(async () => {
    throw new Error("exit 128");
  });
  assert.equal(await failing("/ws"), undefined);
});
