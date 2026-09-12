import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { probeHub, readHubDiscovery, resolveWorkflowHub } from "../src/cli/hub-client.js";

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "task", state: "READY", dependencies: [], requiredEvidence: [] }];
function application() {
  return new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
}

test("readHubDiscovery returns undefined when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    assert.equal(readHubDiscovery(resolveHubDiscoveryPath(dir)), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHubDiscovery parses a discovery file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());

  const discovery = readHubDiscovery(resolveHubDiscoveryPath(dir));
  assert.ok(discovery);
  assert.equal(discovery.endpoint, hub.url);
  assert.equal(typeof discovery.hubId, "string");
  assert.equal(discovery.token.length, 64);
});

test("probeHub is true for a live hub and false for a stale token or dead endpoint", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());

  assert.equal(await probeHub({ hubId: "x", endpoint: hub.url, token: readHubDiscovery(hub.discoveryPath)!.token }), true);
  assert.equal(await probeHub({ hubId: "x", endpoint: hub.url, token: "0".repeat(64) }), false);
  assert.equal(await probeHub({ hubId: "x", endpoint: "http://127.0.0.1:1", token: "0".repeat(64) }), false);
});

test("resolveWorkflowHub returns the live hub authority", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());

  const resolved = await resolveWorkflowHub({ discoveryDir: dir });
  assert.equal(resolved.url, hub.url);
  assert.equal(resolved.token, readHubDiscovery(hub.discoveryPath)!.token);
});

test("resolveWorkflowHub fails closed when the hub is not running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  try {
    await assert.rejects(() => resolveWorkflowHub({ discoveryDir: dir }), /workflow-hub/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorkflowHub removes an obsolete discovery file and fails closed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-client-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const discoveryPath = resolveHubDiscoveryPath(dir);
  mkdirSync(dirname(discoveryPath), { recursive: true });
  writeFileSync(discoveryPath, JSON.stringify({ hubId: "stale", endpoint: "http://127.0.0.1:1", token: "0".repeat(64) }));

  await assert.rejects(() => resolveWorkflowHub({ discoveryDir: dir }), /workflow-hub/);
  assert.equal(existsSync(discoveryPath), false);
});
