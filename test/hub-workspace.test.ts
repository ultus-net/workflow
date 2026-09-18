import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";

/**
 * Per-surface workspace binding: surfaces declare their workspace per request
 * and the hub resolves it against the declared workspace rather than the hub
 * daemon's own cwd. See docs/HUB_PROTOCOL.md §3.
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

async function snapshot(url: string, token: string, body: unknown) {
  const response = await fetch(`${url}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("hub fails closed on an invalid workspace declaration", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const token = hubToken(hub.discoveryPath);

  const relative = await snapshot(hub.url, token, { workspace: "relative/path" });
  assert.notEqual(relative.status, 200);

  const missing = await snapshot(hub.url, token, {
    workspace: join(tmpdir(), "wf-no-such-dir-" + Math.random().toString(16).slice(2)),
  });
  assert.notEqual(missing.status, 200);
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
