import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";

/**
 * The review gate: review-gated runs cannot complete without reviewer evidence
 * from a *different* run, and reviews must reference at least 3 of the 5 axes
 * (anti-rubber-stamp). Ported from opencode-workflow-guard.
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];

function setup() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const workspace = mkdtempSync(join(tmpdir(), "wf-review-ws-"));
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

const AXES_SUMMARY = "test integrity: real assertions. task completeness: done. cleanliness: no dead code. security: no secrets. platform: fits.";

async function hubWith(t: TestContext) {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));
  return { hub, token, application, workspace };
}

test("a review-gated run cannot finish verified without reviewer evidence", async (t) => {
  const { hub, token, application, workspace } = await hubWith(t);
  await post(hub.url, token, "/run/begin", { runId: "author-1", title: "Author run", workspace, requiresReview: true });

  const finish = await post(hub.url, token, "/run/finish", { runId: "author-1", outcome: "verified" });
  assert.notEqual(finish.status, 200);
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.notEqual(runTask?.state, "VERIFIED");
});

test("a review from the same run is rejected (anti-rubber-stamp)", async (t) => {
  const { hub, token, workspace } = await hubWith(t);
  await post(hub.url, token, "/run/begin", { runId: "author-2", title: "Author run", workspace, requiresReview: true });

  const review = await post(hub.url, token, "/run/review", {
    runId: "author-2", reviewerRunId: "author-2", verdict: "approved", summary: AXES_SUMMARY,
  });
  assert.notEqual(review.status, 200);
});

test("a review referencing fewer than three axes is rejected", async (t) => {
  const { hub, token, workspace } = await hubWith(t);
  await post(hub.url, token, "/run/begin", { runId: "author-3", title: "Author run", workspace, requiresReview: true });
  await post(hub.url, token, "/run/begin", { runId: "reviewer-3", title: "Reviewer run", workspace });

  const review = await post(hub.url, token, "/run/review", {
    runId: "author-3", reviewerRunId: "reviewer-3", verdict: "approved", summary: "looks good to me",
  });
  assert.notEqual(review.status, 200);
});

test("an approved cross-run review lets the gated run verify; changes_requested does not", async (t) => {
  const { hub, token, application, workspace } = await hubWith(t);
  await post(hub.url, token, "/run/begin", { runId: "author-4", title: "Author run", workspace, requiresReview: true });
  await post(hub.url, token, "/run/begin", { runId: "reviewer-4", title: "Reviewer run", workspace });

  const changes = await post(hub.url, token, "/run/review", {
    runId: "author-4", reviewerRunId: "reviewer-4", verdict: "changes_requested", summary: AXES_SUMMARY,
  });
  assert.equal(changes.status, 200);
  assert.equal(changes.body.recorded, false);
  const blocked = await post(hub.url, token, "/run/finish", { runId: "author-4", outcome: "verified" });
  assert.notEqual(blocked.status, 200);

  const approved = await post(hub.url, token, "/run/review", {
    runId: "author-4", reviewerRunId: "reviewer-4", verdict: "approved", summary: AXES_SUMMARY,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.recorded, true);

  const finish = await post(hub.url, token, "/run/finish", { runId: "author-4", outcome: "verified" });
  assert.equal(finish.status, 200);
  const snapshot = application.snapshot();
  assert.equal(snapshot.tasks.find((task) => task.title === "Author run")?.state, "VERIFIED");
  assert.ok(snapshot.evidence.some((entry) => entry.authority === "reviewer" && entry.subject === "author-4" && entry.result === "passed"));
});

test("the rubric endpoint embeds the supplied diff", async (t) => {
  const { hub, token } = await hubWith(t);
  const response = await post(hub.url, token, "/review/rubric", { diffText: "diff --git a/x b/x\n+change", taskPrompt: "do the thing" });
  assert.equal(response.status, 200);
  assert.match(String(response.body.rubric), /Test Integrity/);
  assert.match(String(response.body.rubric), /do the thing/);
  assert.match(String(response.body.rubric), /\+change/);
});
