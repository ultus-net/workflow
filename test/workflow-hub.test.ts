import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "task", state: "READY", dependencies: [], requiredEvidence: [] }];
function application() {
  const app = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
  return app;
}

test("workflow-hub daemon writes a discovery file and serves authorization", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const app = application();
  const hub = await createWorkflowHub(app, { discoveryDir: dir });
  t.after(() => hub.close());

  assert.ok(existsSync(discoveryPath));
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
  assert.equal(discovery.hubId?.length, 16);
  assert.equal(discovery.token?.length, 64);
  assert.match(discovery.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);

  const request = await fetch(`${discovery.endpoint}/before-tool`, {
    method: "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ toolCall: { toolName: "execute_command" }, input: {} }),
  });
  assert.equal(request.status, 200);
});

test("workflow-hub startup and snapshot access do not activate interactive work", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = application();
  const hub = await createWorkflowHub(app, { discoveryDir: dir, graph: new TaskGraph(tasks) });
  t.after(() => hub.close());

  assert.equal(app.snapshot().tasks[0]?.state, "READY");
  assert.throws(() => app.activeTaskId(), /no active workflow task selected/);

  const discovery = JSON.parse(readFileSync(hub.discoveryPath, "utf8"));
  const response = await fetch(`${discovery.endpoint}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace: process.cwd() }),
  });

  assert.equal(response.status, 200);
  assert.equal(app.snapshot().tasks[0]?.state, "READY");
  assert.throws(() => app.activeTaskId(), /no active workflow task selected/);
});

test("workflow-hub CLI hides its inactive interactive seed and serves authorization", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-hub-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/hub.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const discoveryPath = resolveHubDiscoveryPath(join(home, ".workflow"));
  await assert.doesNotReject(async () => {
    for (let attempt = 0; attempt < 100 && !existsSync(discoveryPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(discoveryPath), "workflow-hub CLI did not create its discovery file");
  });

  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
  const response = await fetch(`${discovery.endpoint}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace: process.cwd() }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { snapshot: { tasks: Array<{ state: string }> } };
  assert.deepEqual(body.snapshot.tasks, []);

  const authorization = await fetch(`${discovery.endpoint}/before-tool`, {
    method: "POST",
    headers: { authorization: `Bearer ${discovery.token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace: process.cwd(), toolCall: { toolName: "read_file" }, input: { path: "README.md" } }),
  });
  assert.equal(authorization.status, 200);
  assert.deepEqual(await authorization.json(), {});
});

test("resolveHubDiscoveryPath uses the provided data dir", () => {
  assert.equal(resolveHubDiscoveryPath("/tmp/x"), "/tmp/x/hub/discovery.json");
});

test("workflow-hub forwards reviewer and test-runner seams into the run registry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-seams-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-hub-seams-ws-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const app = application();
  const launches: Array<{ runId: string; workspace: string | undefined }> = [];
  const testCalls: Array<{ runId: string; workspace: string | undefined; subject: string }> = [];
  const hub = await createWorkflowHub(app, {
    discoveryDir: dir,
    graph: new TaskGraph(tasks),
    reviewerFactory: (controller) => async (input) => {
      launches.push({ runId: input.runId, workspace: input.workspace });
      await controller.begin({
        runId: "schedule:hub-reviewer-seam",
        title: "Hub reviewer run",
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      });
      await controller.review({
        runId: input.runId,
        reviewerRunId: "schedule:hub-reviewer-seam",
        verdict: "approved",
        summary: "test integrity, task completeness, cleanliness, security, platform",
      });
      return {
        reviewerRunId: "schedule:hub-reviewer-seam",
        verdict: "approved",
        recorded: true,
        summary: "test integrity, task completeness, cleanliness, security, platform",
      };
    },
    testRunner: async (input) => {
      testCalls.push({ runId: input.runId, workspace: input.workspace, subject: input.subject });
      return { passed: true, output: "all green" };
    },
  });
  t.after(() => hub.close());

  const post = async (path: string, body: unknown, token: string) =>
    fetch(`${hub.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const { token } = JSON.parse(readFileSync(hub.discoveryPath, "utf8"));
  await post("/run/begin", { runId: "author-seam", title: "Author run", workspace, requiresReview: true }, token);
  const finish = await post("/run/finish", { runId: "author-seam", outcome: "verified" }, hub.verificationToken);
  assert.equal(finish.status, 200);
  assert.equal(launches.length, 1, "the hub-owned reviewer seam must be reachable through the hub");
  assert.equal(testCalls.length, 1, "the hub test-runner seam must be reachable through the hub");
  assert.equal(testCalls[0]!.subject, `test:${workspace}`);
});
