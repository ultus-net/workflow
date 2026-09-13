import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";

/**
 * Per-surface workspace binding: surfaces declare their workspace per request
 * and the hub authorizes path subjects against the declared workspace rather
 * than the hub daemon's own cwd. See docs/HUB_PROTOCOL.md §3.
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "task", state: "READY", dependencies: [], requiredEvidence: [] }];

function setup() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const hubRoot = mkdtempSync(join(tmpdir(), "wf-hub-root-"));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    hubRoot,
  );
  return { graph, application, hubRoot };
}

async function beforeTool(url: string, token: string, body: unknown) {
  const response = await fetch(`${url}/before-tool`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("hub authorizes path subjects against the declared surface workspace", async (t) => {
  const { graph, application, hubRoot } = setup();
  const surface = mkdtempSync(join(tmpdir(), "wf-surface-"));
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(surface, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const token = hubToken(hub.discoveryPath);

  // A path inside the declared surface workspace is a read within bounds...
  const inside = await beforeTool(hub.url, token, {
    toolCall: { toolName: "read_file" },
    input: { path: join(surface, "notes.txt") },
    workspace: surface,
  });
  assert.equal(inside.status, 200);
  assert.deepEqual(inside.body, {});

  // ...but the same path is outside the hub daemon's own workspace, so without
  // the declared workspace it is denied.
  const undeclared = await beforeTool(hub.url, token, {
    toolCall: { toolName: "read_file" },
    input: { path: join(surface, "notes.txt") },
  });
  assert.equal(undeclared.status, 200);
  assert.match(String(undeclared.body.reason ?? ""), /outside authorized workspace/);

  // And a path outside the declared surface workspace is denied even with the
  // binding.
  const outside = await beforeTool(hub.url, token, {
    toolCall: { toolName: "read_file" },
    input: { path: join(hubRoot, "secret.txt") },
    workspace: surface,
  });
  assert.equal(outside.status, 200);
  assert.match(String(outside.body.reason ?? ""), /outside authorized workspace/);
});

test("hub fails closed on an invalid workspace declaration", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const token = hubToken(hub.discoveryPath);

  const relative = await beforeTool(hub.url, token, {
    toolCall: { toolName: "read_file" },
    input: { path: "README.md" },
    workspace: "relative/path",
  });
  assert.notEqual(relative.status, 200);

  const missing = await beforeTool(hub.url, token, {
    toolCall: { toolName: "read_file" },
    input: { path: "README.md" },
    workspace: join(tmpdir(), "wf-no-such-dir-" + Math.random().toString(16).slice(2)),
  });
  assert.notEqual(missing.status, 200);
});

test("hub namespaces Cline team tasks by workspace and keeps verifier authority out of discovery", async (t) => {
  const { graph, application, hubRoot } = setup();
  const firstWorkspace = mkdtempSync(join(tmpdir(), "wf-team-first-"));
  const secondWorkspace = mkdtempSync(join(tmpdir(), "wf-team-second-"));
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(firstWorkspace, { recursive: true, force: true }));
  t.after(() => rmSync(secondWorkspace, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const discovery = JSON.parse(readFileSync(hub.discoveryPath, "utf8")) as Record<string, unknown>;
  const verifierDiscovery = JSON.parse(readFileSync(hub.verifierDiscoveryPath, "utf8")) as Record<string, unknown>;
  const token = String(discovery.token);
  assert.equal(discovery.verificationToken, undefined);
  assert.notEqual(hub.verificationToken, token);
  assert.equal(verifierDiscovery.endpoint, hub.url);
  assert.equal(verifierDiscovery.token, hub.verificationToken);

  for (const workspace of [firstWorkspace, secondWorkspace]) {
    const response = await fetch(`${hub.url}/team-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        input: { action: "create", title: `Task in ${workspace}` },
        result: { action: "create", taskId: "same-id", status: "pending" },
      }),
    });
    assert.equal(response.status, 200);
  }

  const firstId = taskId(`cline-team:${encodeURIComponent(firstWorkspace)}:same-id`);
  const secondId = taskId(`cline-team:${encodeURIComponent(secondWorkspace)}:same-id`);
  assert.notEqual(firstId, secondId);
  assert.equal(application.snapshot().tasks.find(({ id }) => id === firstId)?.title, `Task in ${firstWorkspace}`);
  assert.equal(application.snapshot().tasks.find(({ id }) => id === secondId)?.title, `Task in ${secondWorkspace}`);

  const completed = await fetch(`${hub.url}/team-task`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      workspace: firstWorkspace,
      input: { action: "complete", taskId: "same-id" },
      result: { action: "complete", taskId: "same-id", status: "completed" },
    }),
  });
  assert.equal(completed.status, 200);
  const verified = await fetch(`${hub.url}/team-task/verify`, {
    method: "POST",
    headers: { authorization: `Bearer ${String(verifierDiscovery.token)}`, "content-type": "application/json" },
    body: JSON.stringify({
      workspace: firstWorkspace,
      taskId: "same-id",
      evidence: {
        id: "hub-workspace-evidence",
        observationId: "hub-workspace-observation",
        authority: "environment",
        subject: firstId,
        result: "passed",
        freshness: "fresh",
        mutationEpoch: application.snapshot().mutationEpoch,
        observedAt: new Date().toISOString(),
      },
    }),
  });
  assert.equal(verified.status, 200);
  assert.equal(application.snapshot().tasks.find(({ id }) => id === firstId)?.state, "VERIFIED");
  assert.equal(application.snapshot().tasks.find(({ id }) => id === secondId)?.state, "READY");
});

test("hub canonicalizes workspace aliases before identifying Cline team tasks", async (t) => {
  const { graph, application, hubRoot } = setup();
  const workspace = mkdtempSync(join(tmpdir(), "wf-team-real-"));
  const aliasRoot = mkdtempSync(join(tmpdir(), "wf-team-alias-root-"));
  const alias = join(aliasRoot, "workspace");
  symlinkSync(workspace, alias, "dir");
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(aliasRoot, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const token = hubToken(hub.discoveryPath);
  for (const declaredWorkspace of [workspace, alias]) {
    const response = await fetch(`${hub.url}/team-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        workspace: declaredWorkspace,
        input: { action: "create", title: "Same physical workspace" },
        result: { action: "create", taskId: "alias-id", status: "pending" },
      }),
    });
    assert.equal(response.status, 200);
  }

  const matching = application.snapshot().tasks.filter(({ id }) => id.endsWith(":alias-id"));
  assert.equal(matching.length, 1);
  assert.equal(matching[0]?.id, `cline-team:${encodeURIComponent(workspace)}:alias-id`);
});

test("hub protects and removes verifier discovery on shutdown", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  assert.equal(statSync(hub.verifierDiscoveryPath).mode & 0o777, 0o600);
  await hub.close();
  assert.equal(existsSync(hub.verifierDiscoveryPath), false);
});

test("hub cleans up a partially started bridge when verifier discovery cannot publish", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  const hubDir = join(dir, "hub");
  const discoveryPath = join(hubDir, "discovery.json");
  const verifierPath = join(hubDir, "verifier.json");
  let startedBridgeUrl: string | undefined;
  mkdirSync(verifierPath, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  await assert.rejects(createWorkflowHub(application, {
    discoveryDir: dir,
    graph,
    observeBridgeStarted: (url) => { startedBridgeUrl = url; },
  }));
  assert.equal(existsSync(discoveryPath), false);
  assert.equal(statSync(verifierPath).isDirectory(), true);
  assert.ok(startedBridgeUrl);
  await assert.rejects(fetch(`${startedBridgeUrl}/health`, { method: "POST" }));

  rmSync(verifierPath, { recursive: true });
  const restarted = await createWorkflowHub(application, { discoveryDir: dir, graph });
  await restarted.close();
});

function hubToken(discoveryPath: string): string {
  return (JSON.parse(readFileSync(discoveryPath, "utf8")) as { token: string }).token;
}
