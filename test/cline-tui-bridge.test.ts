import assert from "node:assert/strict";
import test from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { createWorkflowClineTuiBridge } from "../src/integrations/cline-tui-bridge.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";

test("Cline TUI bridge requires its random bearer token", async () => {
  const bridge = await createWorkflowClineTuiBridge(application());
  try {
    const response = await fetch(`${bridge.url}/before-tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolCall: { toolName: "read_file" }, input: { path: "README.md" } }),
    });
    assert.equal(response.status, 401);
  } finally {
    await bridge.close();
  }
});

test("Cline TUI bridge delegates beforeTool decisions to Workflow", async () => {
  const app = application();
  app.startInteractiveTask();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    const response = await fetch(`${bridge.url}/before-tool`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ toolCall: { toolName: "fetch_web_content" }, input: { url: "https://example.com" } }),
    });
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(await response.json()), /network/);
  } finally {
    await bridge.close();
  }
});

function application(): WorkflowApplication {
  const task: WorkflowTask = {
    id: taskId("A"),
    title: "Interactive task",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  };
  return new WorkflowApplication(
    new TaskGraph([task]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
  );
}
