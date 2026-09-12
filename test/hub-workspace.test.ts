import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function hubToken(discoveryPath: string): string {
  return (JSON.parse(readFileSync(discoveryPath, "utf8")) as { token: string }).token;
}
