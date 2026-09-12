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

test("a scheduled run gets its own task, authorization scope, and evidence", async (t) => {
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

  const finish = await post(hub.url, token, "/run/finish", {
    runId: "cron-2026-09-12-nightly",
    outcome: "verified",
  });
  assert.equal(finish.status, 200);

  const snapshot = application.snapshot();
  const runTask = snapshot.tasks.find((task) => task.title === "Nightly dependency audit");
  assert.ok(runTask);
  assert.equal(runTask.state, "VERIFIED");
  const evidence = snapshot.evidence.find((entry) => entry.subject === "cron-2026-09-12-nightly");
  assert.ok(evidence);
  assert.equal(evidence.result, "passed");
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
  const finish = await post(hub.url, token, "/run/finish", { runId: "cron-broken", outcome: "failed" });
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

  const finish = await post(hub.url, token, "/run/finish", { runId: "cron-ghost", outcome: "verified" });
  assert.notEqual(finish.status, 200);
});
