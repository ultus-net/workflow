import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { readHubDiscovery } from "../src/cli/hub-client.js";
import { createHubSnapshotSource, emptyHubSnapshot, fetchHubSnapshot } from "../src/cli/hub-snapshot.js";

const tasks: WorkflowTask[] = [
  {
    id: taskId("W1"),
    title: "observed via hub",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  },
];

function application() {
  return new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
}

test("emptyHubSnapshot is a valid empty projection", () => {
  const empty = emptyHubSnapshot();
  assert.deepEqual(empty.tasks, []);
  assert.equal(empty.mutationEpoch, 0);
});

test("fetchHubSnapshot returns the full canonical snapshot over the hub protocol", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());
  const discovery = readHubDiscovery(resolveHubDiscoveryPath(dir));
  assert.ok(discovery);

  const snapshot = await fetchHubSnapshot({ url: discovery.endpoint, token: discovery.token }, process.cwd());
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0]!.title, "observed via hub");
  assert.equal(snapshot.transport, "native");
  assert.equal(snapshot.enforcementLevel, "enforced");
  assert.ok(Array.isArray(snapshot.history));
  assert.ok(Array.isArray(snapshot.evidence));
});

test("createHubSnapshotSource refreshes its cached projection", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());
  const discovery = readHubDiscovery(resolveHubDiscoveryPath(dir));
  assert.ok(discovery);

  const source = createHubSnapshotSource({ url: discovery.endpoint, token: discovery.token }, process.cwd());
  assert.equal(source.snapshot().tasks.length, 0, "empty before first refresh");
  await source.refresh();
  assert.equal(source.snapshot().tasks.length, 1);
});

test("fetchHubSnapshot fails on an unauthorized request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(application(), { discoveryDir: dir });
  t.after(() => hub.close());

  await assert.rejects(
    () => fetchHubSnapshot({ url: hub.url, token: "0".repeat(64) }, process.cwd()),
    /status 401/,
  );
});
