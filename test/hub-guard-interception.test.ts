import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { defaultToolboxGuardServerPath, createWorkflowGuardMcpProvider } from "../src/integrations/mcp-toolbox-guard.js";

const tasks: WorkflowTask[] = [{ id: taskId("interactive"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];

function setup() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const workspace = mkdtempSync(join(tmpdir(), "wf-guard-test-ws-"));
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

test("Workflow hub with guard intercepts destructive commands and protected paths", async (t) => {
  const { graph, application, workspace } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const guard = await createWorkflowGuardMcpProvider({ serverPath: defaultToolboxGuardServerPath() });
  t.after(() => guard.close());

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph, guard });
  t.after(() => hub.close());
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8"));

  // 1. Safe command in beforeTool is allowed
  const safeBefore = await post(hub.url, token, "/before-tool", {
    workspace,
    input: { command: "git status" },
    toolCall: { toolName: "execute_command" },
  });
  assert.equal(safeBefore.status, 200);
  assert.notEqual(safeBefore.body.stop, true);

  // 2. Destructive command in beforeTool is stopped by guard
  const destructiveBefore = await post(hub.url, token, "/before-tool", {
    workspace,
    input: { command: "npm install -g evil-tool" },
    toolCall: { toolName: "execute_command" },
  });
  assert.equal(destructiveBefore.status, 200);
  assert.equal(destructiveBefore.body.stop, true);
  assert.match(String(destructiveBefore.body.reason), /guard policy/);

  // 3. Write to secret credential path (.env inside workspace) in beforeTool is stopped by guard
  const protectedWrite = await post(hub.url, token, "/before-tool", {
    workspace,
    input: { path: join(workspace, ".env"), content: "SECRET=123" },
    toolCall: { toolName: "write_to_file" },
  });
  assert.equal(protectedWrite.status, 200);
  assert.equal(protectedWrite.body.stop, true);
  assert.match(String(protectedWrite.body.reason), /guard policy/);

  // 4. In bash executor, guard intercepts destructive command
  const bashDenied = await post(hub.url, token, "/bash", {
    workspace,
    cwd: workspace,
    command: "npm install -g evil-tool",
  });
  assert.equal(bashDenied.status, 500);
  assert.match(String(bashDenied.body.error), /guard denied/);

  // 5. In bash executor, safe command succeeds
  const bashAllowed = await post(hub.url, token, "/bash", {
    workspace,
    cwd: workspace,
    command: "echo guard_active",
  });
  assert.equal(bashAllowed.status, 200);
  assert.match(String(bashAllowed.body.output), /guard_active/);
});
