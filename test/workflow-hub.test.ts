import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("resolveHubDiscoveryPath uses the provided data dir", () => {
  assert.equal(resolveHubDiscoveryPath("/tmp/x"), "/tmp/x/hub/discovery.json");
});
