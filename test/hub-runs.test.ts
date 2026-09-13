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
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

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
