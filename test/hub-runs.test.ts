import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import type { HubReviewerResult } from "../src/integrations/hub-reviewer.js";

/**
 * Dedicated task/evidence per scheduled (cron) run: a surface begins a run,
 * authorizes tool calls against it, and finishes it with recorded evidence.
 * See docs/HUB_PROTOCOL.md §3 (`/run/begin`, `/run/finish`).
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];

function setup() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const workspace = mkdtempSync(join(tmpdir(), "wf-run-ws-"));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
  return { graph, application, workspace };
}

async function post(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("a scheduled run needs verifier authority to finish successfully", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  const begin = await post(hub.url, token, "/run/begin", {
    runId: "cron-2026-09-12-nightly",
    title: "Nightly dependency audit",
    workspace,
  });
  assert.equal(begin.status, 200);

  // Mutating tool calls are authorized against the run's IN_PROGRESS task.
  const authorized = await post(hub.url, token, "/before-tool", {
    toolCall: { toolName: "write_to_file" },
    input: { path: join(workspace, "report.md") },
    workspace,
    runId: "cron-2026-09-12-nightly",
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body, {});

  const ordinaryFinish = await post(hub.url, token, "/run/finish", {
    runId: "cron-2026-09-12-nightly",
    outcome: "verified",
  });
  assert.equal(ordinaryFinish.status, 401);

  const finish = await post(hub.url, hub.verificationToken, "/run/finish", {
    runId: "cron-2026-09-12-nightly",
    outcome: "verified",
  });
  assert.equal(finish.status, 200);

  const snapshot = application.snapshot();
  const runTask = snapshot.tasks.find((task) => task.title === "Nightly dependency audit");
  assert.ok(runTask);
  assert.equal(runTask.state, "VERIFIED");
  // Finish must not fabricate evidence: a plain run has no evidence
  // requirements, so the kernel promotes it on transition alone.
  assert.equal(snapshot.evidence.some((entry) => entry.subject === "cron-2026-09-12-nightly"), false);
});

test("a review-gated run cannot finish until an independent review is recorded", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  await post(hub.url, token, "/run/begin", {
    runId: "schedule:author",
    title: "Authoring run",
    workspace,
    requiresReview: true,
  });
  await post(hub.url, token, "/run/begin", { runId: "schedule:reviewer", title: "Reviewer run", workspace });

  // Finishing before any review must fail closed: the kernel rejects VERIFIED
  // while the reviewer-evidence requirement is unmet.
  const premature = await post(hub.url, hub.verificationToken, "/run/finish", {
    runId: "schedule:author",
    outcome: "verified",
  });
  assert.notEqual(premature.status, 200);
  assert.equal(
    application.snapshot().tasks.find((task) => task.title === "Authoring run")?.state,
    "VERIFYING",
  );

  // A self-review is rejected by the cross-run anti-rubber-stamp rule.
  const selfReview = await post(hub.url, hub.verificationToken, "/run/review", {
    runId: "schedule:author",
    reviewerRunId: "schedule:author",
    verdict: "approved",
    summary: "test integrity, task completeness, security",
  });
  assert.notEqual(selfReview.status, 200);

  const review = await post(hub.url, hub.verificationToken, "/run/review", {
    runId: "schedule:author",
    reviewerRunId: "schedule:reviewer",
    verdict: "approved",
    summary: "test integrity, task completeness, security",
  });
  assert.equal(review.status, 200);

  const finish = await post(hub.url, hub.verificationToken, "/run/finish", {
    runId: "schedule:author",
    outcome: "verified",
  });
  assert.equal(finish.status, 200);
  assert.equal(
    application.snapshot().tasks.find((task) => task.title === "Authoring run")?.state,
    "VERIFIED",
  );
});

test("a failed run is recorded as FAILED with failed evidence", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  await post(hub.url, token, "/run/begin", { runId: "cron-broken", title: "Broken run", workspace });
  const finish = await post(hub.url, hub.verificationToken, "/run/finish", { runId: "cron-broken", outcome: "failed" });
  assert.equal(finish.status, 200);

  const snapshot = application.snapshot();
  assert.equal(snapshot.tasks.find((task) => task.title === "Broken run")?.state, "FAILED");
  assert.equal(snapshot.evidence.find((entry) => entry.subject === "cron-broken")?.result, "failed");
});

test("tool calls for an unknown run fail closed", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  const response = await post(hub.url, token, "/before-tool", {
    toolCall: { toolName: "read_file" },
    input: {},
    workspace,
    runId: "cron-never-began",
  });
  assert.notEqual(response.status, 200);
});

test("finishing an unknown run fails closed", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());

  const finish = await post(hub.url, hub.verificationToken, "/run/finish", { runId: "cron-ghost", outcome: "verified" });
  assert.notEqual(finish.status, 200);
});

test("hub snapshot hides the redundant interactive seed task", async (t) => {
  const { graph, application, workspace } = setup();
  application.addTask({ id: taskId("interactive"), title: "Interactive coding session", dependencies: [], requiredEvidence: [] });
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  const snapshot = await post(hub.url, token, "/snapshot", { workspace });
  assert.equal(snapshot.status, 200);
  const projected = snapshot.body.snapshot as { tasks: Array<{ id: string }> };
  assert.equal(projected.tasks.some(({ id }) => id === "interactive"), false);
});

// ── Task A2: automatic review trigger on run completion ─────────────────────

const AXES_SUMMARY = "test integrity: real assertions. task completeness: done. cleanliness: no dead code.";

function setupRegistry() {
  const { graph, application, workspace } = setup();
  return { graph, application, workspace };
}

function registryWithReviewer(outcome: { result: HubReviewerResult } | { error: Error }) {
  const base = setupRegistry();
  const launches: Array<{ runId: string; workspace: string | undefined }> = [];
  const registry = createRunRegistry(base.application, base.graph, {
    reviewer: (controller) => async (input) => {
      launches.push({ runId: input.runId, workspace: input.workspace });
      if ("error" in outcome) throw outcome.error;
      const { result } = outcome;
      if (result.recorded) {
        // Emulate the hub reviewer runner's recording path: begin the
        // reviewer as its own registered run, then record through the
        // controller so `recorded` reflects kernel-admitted evidence.
        await controller.begin({
          runId: result.reviewerRunId,
          title: "Hub reviewer run",
          ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        });
        await controller.review({
          runId: input.runId,
          reviewerRunId: result.reviewerRunId,
          verdict: "approved",
          summary: result.summary,
        });
      }
      return result;
    },
  });
  return { ...base, registry, launches };
}

test("a review-gated run auto-launches the hub reviewer on finish and verifies on approval", async () => {
  const { application, workspace, registry, launches } = registryWithReviewer({
    result: {
      reviewerRunId: "schedule:hub-reviewer-1",
      verdict: "approved",
      recorded: true,
      summary: AXES_SUMMARY,
    },
  });
  await registry.controller.begin({ runId: "author-1", title: "Author run", workspace, requiresReview: true });

  await registry.controller.finish({ runId: "author-1", outcome: "verified" });

  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.runId, "author-1");
  assert.equal(launches[0]!.workspace, workspace);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
  assert.equal(registry.reviewOutcomes().get("author-1")?.verdict, "approved");
  assert.equal(registry.blockingReasons().has("author-1"), false);
});

test("a fail-closed reviewer outcome leaves the run VERIFYING with a surfaced blocking reason", async () => {
  const { application, workspace, registry, launches } = registryWithReviewer({
    result: {
      reviewerRunId: "schedule:hub-reviewer-2",
      verdict: "changes_requested",
      recorded: false,
      summary: "weak coverage",
      parseFailure: "approved review summary must reference at least 3 of the 5 axes (found 0)",
    },
  });
  await registry.controller.begin({ runId: "author-2", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(registry.controller.finish({ runId: "author-2", outcome: "verified" }), /axes/);
  assert.equal(launches.length, 1);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFYING");
  assert.match(registry.blockingReasons().get("author-2") ?? "", /axes/);
  assert.equal(registry.reviewOutcomes().get("author-2")?.verdict, "changes_requested");
});

test("reviewer infrastructure failure leaves the run VERIFYING with a surfaced blocking reason", async () => {
  const { application, workspace, registry } = registryWithReviewer({ error: new Error("reviewer agent crashed") });
  await registry.controller.begin({ runId: "author-3", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(registry.controller.finish({ runId: "author-3", outcome: "verified" }), /hub reviewer failed/);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFYING");
  assert.match(registry.blockingReasons().get("author-3") ?? "", /reviewer agent crashed/);
});

test("plain runs never launch the reviewer on finish (explicit-policy semantics unchanged)", async () => {
  const { application, workspace, registry, launches } = registryWithReviewer({
    result: { reviewerRunId: "schedule:hub-reviewer-4", verdict: "approved", recorded: true, summary: AXES_SUMMARY },
  });
  await registry.controller.begin({ runId: "author-4", title: "Author run", workspace });

  await registry.controller.finish({ runId: "author-4", outcome: "verified" });

  assert.equal(launches.length, 0);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
});

test("a run left VERIFYING by a failed review can still verify after evidence is recorded", async () => {
  const { application, workspace, registry } = registryWithReviewer({
    result: {
      reviewerRunId: "schedule:hub-reviewer-5",
      verdict: "changes_requested",
      recorded: false,
      summary: "unparseable reviewer verdict: ???",
      parseFailure: "unparseable reviewer verdict: ???",
    },
  });
  await registry.controller.begin({ runId: "author-5", title: "Author run", workspace, requiresReview: true });
  await assert.rejects(registry.controller.finish({ runId: "author-5", outcome: "verified" }), /unparseable/);

  // Evidence recorded later through the ordinary verifier path unblocks the run.
  await registry.controller.begin({ runId: "late-reviewer", title: "Late reviewer run", workspace });
  await registry.controller.review({
    runId: "author-5",
    reviewerRunId: "late-reviewer",
    verdict: "approved",
    summary: AXES_SUMMARY,
  });

  await registry.controller.finish({ runId: "author-5", outcome: "verified" });
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
  assert.equal(registry.blockingReasons().has("author-5"), false);
});

// ── Task D1: hub-run test evidence before VERIFIED ──────────────────────────

function registryWithGates(testOutcome: { passed: boolean; output: string } | Error) {
  const base = setupRegistry();
  const launches: Array<{ runId: string; workspace: string | undefined }> = [];
  const testCalls: Array<{ runId: string; workspace: string | undefined; subject: string }> = [];
  const registry = createRunRegistry(base.application, base.graph, {
    reviewer: (controller) => async (input) => {
      launches.push({ runId: input.runId, workspace: input.workspace });
      await controller.begin({
        runId: "schedule:hub-reviewer-d1",
        title: "Hub reviewer run",
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      });
      await controller.review({
        runId: input.runId,
        reviewerRunId: "schedule:hub-reviewer-d1",
        verdict: "approved",
        summary: AXES_SUMMARY,
      });
      return { reviewerRunId: "schedule:hub-reviewer-d1", verdict: "approved", recorded: true, summary: AXES_SUMMARY };
    },
    testRunner: async (input) => {
      testCalls.push({ runId: input.runId, workspace: input.workspace, subject: input.subject });
      if (testOutcome instanceof Error) throw testOutcome;
      return testOutcome;
    },
  });
  return { ...base, registry, launches, testCalls };
}

test("a review-gated run also requires hub-run test evidence: failing tests block verification", async () => {
  const { application, workspace, registry, testCalls } = registryWithGates({
    passed: false,
    output: "1 failing: expected 3, got 4",
  });
  await registry.controller.begin({ runId: "author-d1", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(registry.controller.finish({ runId: "author-d1", outcome: "verified" }), /test evidence failed/);
  assert.equal(testCalls.length, 1);
  assert.equal(testCalls[0]!.subject, `test:${workspace}`);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFYING");
  assert.match(registry.blockingReasons().get("author-d1") ?? "", /expected 3, got 4/);
});

test("passing hub-run test evidence completes the verified review-gated run", async () => {
  const { application, workspace, registry, testCalls } = registryWithGates({ passed: true, output: "all green" });
  await registry.controller.begin({ runId: "author-d2", title: "Author run", workspace, requiresReview: true });

  await registry.controller.finish({ runId: "author-d2", outcome: "verified" });

  assert.equal(testCalls.length, 1);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
  assert.equal(registry.blockingReasons().has("author-d2"), false);
});

test("plain runs never run the hub test command", async () => {
  const { workspace, registry, testCalls } = registryWithGates({ passed: true, output: "all green" });
  await registry.controller.begin({ runId: "author-d3", title: "Author run", workspace });

  await registry.controller.finish({ runId: "author-d3", outcome: "verified" });

  assert.equal(testCalls.length, 0);
  const runTask = registry.resolve(undefined, undefined).snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFIED");
});

test("a crashing hub test run fails closed with a surfaced blocking reason", async () => {
  const { application, workspace, registry } = registryWithGates(new Error("test command crashed"));
  await registry.controller.begin({ runId: "author-d4", title: "Author run", workspace, requiresReview: true });

  await assert.rejects(registry.controller.finish({ runId: "author-d4", outcome: "verified" }), /hub test run failed/);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "VERIFYING");
  assert.match(registry.blockingReasons().get("author-d4") ?? "", /test command crashed/);
});
