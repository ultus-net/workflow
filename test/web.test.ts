import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

import {
  TaskGraph,
  WorkflowApplication,
  createWorkflowWebServer,
  hostCapabilities,
  taskId,
  type WorkflowTask,
} from "../src/index.js";

test("web UI reads snapshots and submits commands through the application API", async (context) => {
  const tasks: WorkflowTask[] = [{
    id: taskId("A"), title: "Web task", state: "BLOCKED", dependencies: [], requiredEvidence: [],
  }];
  const application = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Workflow Control/);

  const before = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((response) => response.json()) as { tasks: { state: string }[] };
  assert.equal(before.tasks[0]?.state, "READY");

  const transition = await fetch(`http://127.0.0.1:${port}/api/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "A", requested: "IN_PROGRESS" }),
  });
  assert.equal(transition.status, 200);
  const after = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((response) => response.json()) as { tasks: { state: string }[] };
  assert.equal(after.tasks[0]?.state, "IN_PROGRESS");
});
