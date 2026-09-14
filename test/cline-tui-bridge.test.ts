import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { createWorkflowBridge } from "../.workflow-cline/cline/apps/cli/src/utils/workflow-bridge.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { createWorkflowClineTuiBridge, recordClineTeamTaskEnvironmentEvidence } from "../src/integrations/cline-tui-bridge.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import { evidenceId, observationId, taskId, type WorkflowTask } from "../src/kernel/contracts.js";
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

test("Cline TUI bridge observes request paths without query strings", async () => {
  const observedPaths: string[] = [];
  const bridge = await createWorkflowClineTuiBridge(application(), undefined, undefined, (path) => observedPaths.push(path));
  try {
    const response = await fetch(`${bridge.url}/before-tool?sensitive=value`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(observedPaths, ["/before-tool"]);
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

test("Cline maps a real Workflow denial to skip and continues authorizing later tools", async () => {
  const app = application();
  app.startInteractiveTask();
  const authority = await createWorkflowClineTuiBridge(app);
  const previousUrl = process.env.WORKFLOW_CLINE_BRIDGE_URL;
  const previousToken = process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
  process.env.WORKFLOW_CLINE_BRIDGE_URL = authority.url;
  process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = authority.token;
  try {
    let upstreamCalls = 0;
    const hooks = createWorkflowBridge().authorize({
      beforeTool: async () => {
        upstreamCalls += 1;
        return {};
      },
    });
    const denied = await hooks.beforeTool?.({
      toolCall: { toolName: "fetch_web_content" },
      input: { url: "https://example.com" },
    } as never);
    assert.equal(denied?.skip, true);
    assert.equal(denied?.stop, undefined);
    assert.match(denied?.reason ?? "", /network/);
    assert.equal(upstreamCalls, 0);

    const allowed = await hooks.beforeTool?.({
      toolCall: { toolName: "read_file" },
      input: { path: "README.md" },
    } as never);
    assert.deepEqual(allowed, {});
    assert.equal(upstreamCalls, 1);
  } finally {
    if (previousUrl === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_URL;
    else process.env.WORKFLOW_CLINE_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
    else process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = previousToken;
    await authority.close();
  }
});

test("Cline TUI bridge exposes the Workflow snapshot for presentation", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    const response = await fetch(`${bridge.url}/snapshot`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { snapshot: { tasks: Array<{ title: string; state: string }> } };
    assert.deepEqual(payload.snapshot.tasks, [{
      id: "A",
      title: "Interactive task",
      state: "READY",
      blockers: [],
    }]);
  } finally {
    await bridge.close();
  }
});

test("Cline TUI bridge projects successful team_task updates into canonical Workflow tasks", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    const response = await fetch(`${bridge.url}/team-task`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspace: process.cwd(),
        input: { action: "create", title: "Task list smoke test item A", description: "Smoke test" },
        result: { action: "create", taskId: "task_0001", status: "pending" },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(
      app.snapshot().tasks.find((task) => task.id === "cline-team:task_0001")?.title,
      "Task list smoke test item A",
    );

    for (const [input, result] of [
      [{ action: "claim", taskId: "task_0001" }, { action: "claim", taskId: "task_0001", status: "in_progress" }],
      [{ action: "complete", taskId: "task_0001", summary: "Done" }, { action: "complete", taskId: "task_0001", status: "completed" }],
    ] as const) {
      const update = await fetch(`${bridge.url}/team-task`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspace: process.cwd(), input, result }),
      });
      assert.equal(update.status, 200);
    }
    assert.equal(app.snapshot().tasks.find((task) => task.id === "cline-team:task_0001")?.state, "VERIFYING");

    const duplicateComplete = await fetch(`${bridge.url}/team-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        workspace: process.cwd(),
        input: { action: "complete", taskId: "task_0001", summary: "Done" },
        result: { action: "complete", taskId: "task_0001", status: "completed" },
      }),
    });
    assert.equal(duplicateComplete.status, 200);

    const mismatch = await fetch(`${bridge.url}/team-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        workspace: process.cwd(),
        input: { action: "claim", taskId: "task_0001" },
        result: { action: "claim", taskId: "task_other", status: "in_progress" },
      }),
    });
    assert.equal(mismatch.status, 500);
  } finally {
    await bridge.close();
  }
});

test("Cline team tasks require explicit task-bound evidence before verification", async () => {
  const app = application();
  app.startInteractiveTask();
  const bridge = await createWorkflowClineTuiBridge(app);
  const post = (path: string, body: unknown, token = bridge.token) => fetch(`${bridge.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    await post("/team-task", {
      workspace: process.cwd(),
      input: { action: "create", title: "Evidence-bound task" },
      result: { action: "create", taskId: "task_evidence", status: "pending" },
    });
    await post("/team-task", {
      workspace: process.cwd(),
      input: { action: "complete", taskId: "task_evidence" },
      result: { action: "complete", taskId: "task_evidence", status: "completed" },
    });

    const canonicalId = taskId("cline-team:task_evidence");
    assert.equal(app.snapshot().tasks.find(({ id }) => id === canonicalId)?.state, "VERIFYING");
    assert.equal(app.transition(canonicalId, "VERIFIED").kind, "rejected", "completion must not self-certify");
    assert.equal(app.snapshot().tasks.find(({ id }) => id === taskId("A"))?.state, "IN_PROGRESS");

    const clineSelfCertification = await post("/team-task/verify", {
      workspace: process.cwd(),
      taskId: "task_evidence",
      evidence: {
        id: "cline-team-evidence:self-certified",
        observationId: "cline-team-observation:self-certified",
        authority: "environment",
        subject: "cline-team:task_evidence",
        result: "passed",
        freshness: "fresh",
        mutationEpoch: app.snapshot().mutationEpoch,
        observedAt: new Date().toISOString(),
      },
    });
    assert.equal(clineSelfCertification.status, 401, "the Cline bearer token must not carry verification authority");

    const wrongSubject = await post("/team-task/verify", {
      workspace: process.cwd(),
      taskId: "task_evidence",
      evidence: {
        id: "cline-team-evidence:wrong",
        observationId: "cline-team-observation:wrong",
        authority: "environment",
        subject: "cline-team:another-task",
        result: "passed",
        freshness: "fresh",
        mutationEpoch: app.snapshot().mutationEpoch,
        observedAt: new Date().toISOString(),
      },
    }, bridge.verificationToken);
    assert.equal(wrongSubject.status, 500);
    assert.equal(app.snapshot().tasks.find(({ id }) => id === canonicalId)?.state, "VERIFYING");

    for (const [suffix, evidence] of [
      ["failed", { result: "failed", freshness: "fresh", mutationEpoch: app.snapshot().mutationEpoch }],
      ["stale", { result: "passed", freshness: "stale", mutationEpoch: app.snapshot().mutationEpoch }],
      ["wrong-epoch", { result: "passed", freshness: "fresh", mutationEpoch: app.snapshot().mutationEpoch + 1 }],
    ] as const) {
      const rejected = await post("/team-task/verify", {
        workspace: process.cwd(),
        taskId: "task_evidence",
        evidence: {
          id: `cline-team-evidence:${suffix}`,
          observationId: `cline-team-observation:${suffix}`,
          authority: "environment",
          subject: "cline-team:task_evidence",
          ...evidence,
          observedAt: new Date().toISOString(),
        },
      }, bridge.verificationToken);
      assert.equal(rejected.status, 500, `${suffix} evidence must fail closed`);
      assert.equal(app.snapshot().tasks.find(({ id }) => id === canonicalId)?.state, "VERIFYING");
    }

    const verification = await post("/team-task/verify", {
      workspace: process.cwd(),
      taskId: "task_evidence",
      evidence: {
        id: evidenceId("cline-team-evidence:task_evidence"),
        observationId: observationId("cline-team-observation:task_evidence"),
        authority: "environment",
        subject: "cline-team:task_evidence",
        result: "passed",
        freshness: "fresh",
        mutationEpoch: app.snapshot().mutationEpoch,
        observedAt: new Date().toISOString(),
      },
    }, bridge.verificationToken);
    assert.equal(verification.status, 200);
    assert.equal(app.snapshot().tasks.find(({ id }) => id === canonicalId)?.state, "VERIFIED");
    assert.equal(app.snapshot().tasks.find(({ id }) => id === taskId("A"))?.state, "IN_PROGRESS");
  } finally {
    await bridge.close();
  }
});

test("trusted command evidence promotes a verifying Cline team task in process", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    await syncCompletedTeamTask(bridge, "task_command_verified");
    const id = taskId("cline-team:task_command_verified");

    recordClineTeamTaskEnvironmentEvidence(app, id, {
      id: evidenceId("command-evidence:passed"),
      observationId: observationId("command-observation:passed"),
      result: "passed",
      mutationEpoch: app.snapshot().mutationEpoch,
      observedAt: new Date().toISOString(),
    });

    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFIED");
  } finally {
    await bridge.close();
  }
});

test("passing command evidence recorded before Cline completion leaves task verifying until trusted verification", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    const post = (input: unknown, result: unknown) => fetch(`${bridge.url}/team-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: process.cwd(), input, result }),
    });
    await post(
      { action: "create", title: "Command then complete", assignee: "worker" },
      { action: "create", taskId: "task_command_then_complete", status: "in_progress" },
    );
    const id = taskId("cline-team:task_command_then_complete");
    app.recordMutation([id]);
    recordClineTeamTaskEnvironmentEvidence(app, id, {
      id: evidenceId("command-evidence:before-complete"),
      observationId: observationId("command-observation:before-complete"),
      result: "passed",
      mutationEpoch: app.snapshot().mutationEpoch,
      observedAt: new Date().toISOString(),
    });
    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "IN_PROGRESS");

    const completed = await post(
      { action: "complete", taskId: "task_command_then_complete" },
      { action: "complete", taskId: "task_command_then_complete", status: "completed" },
    );
    assert.equal(completed.status, 200);
    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFYING");

    // Trusted transition promotes once completion moves the task to VERIFYING.
    assert.equal(app.transition(id, "VERIFIED").kind, "accepted");
    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFIED");
  } finally {
    await bridge.close();
  }
});

test("failed command evidence leaves a Cline team task verifying", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    await syncCompletedTeamTask(bridge, "task_command_failed");
    const id = taskId("cline-team:task_command_failed");

    recordClineTeamTaskEnvironmentEvidence(app, id, {
      id: evidenceId("command-evidence:failed"),
      observationId: observationId("command-observation:failed"),
      result: "failed",
      mutationEpoch: app.snapshot().mutationEpoch,
      observedAt: new Date().toISOString(),
    });

    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFYING");
  } finally {
    await bridge.close();
  }
});

test("mutation after command evidence prevents later Cline team task promotion", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    await syncCompletedTeamTask(bridge, "task_command_stale");
    const id = taskId("cline-team:task_command_stale");
    app.recordEvidence({
      id: evidenceId("command-evidence:stale"),
      observationId: observationId("command-observation:stale"),
      authority: "environment",
      subject: id,
      result: "passed",
      freshness: "fresh",
      mutationEpoch: app.snapshot().mutationEpoch,
      observedAt: new Date().toISOString(),
    });
    app.recordMutation([id]);

    assert.throws(() => recordClineTeamTaskEnvironmentEvidence(app, id, {
      id: evidenceId("command-evidence:stale"),
      observationId: observationId("command-observation:stale"),
      result: "passed",
      mutationEpoch: app.snapshot().mutationEpoch - 1,
      observedAt: new Date().toISOString(),
    }));
    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFYING");
  } finally {
    await bridge.close();
  }
});

test("recordEvidence alone never promotes a verifying Cline team task", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  try {
    await syncCompletedTeamTask(bridge, "task_evidence_only");
    const id = taskId("cline-team:task_evidence_only");
    app.recordEvidence({
      id: evidenceId("command-evidence:only"),
      observationId: observationId("command-observation:only"),
      authority: "environment",
      subject: id,
      result: "passed",
      freshness: "fresh",
      mutationEpoch: app.snapshot().mutationEpoch,
      observedAt: new Date().toISOString(),
    });

    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFYING");
  } finally {
    await bridge.close();
  }
});

test("Cline TUI bridge projects assigned creates and direct terminal updates through legal Workflow states", async () => {
  const app = application();
  const bridge = await createWorkflowClineTuiBridge(app);
  const postTeamTask = (input: unknown, result: unknown) => fetch(`${bridge.url}/team-task`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace: process.cwd(), input, result }),
  });
  try {
    const assignedCreate = await postTeamTask(
      { action: "create", title: "Assigned task", assignee: "worker" },
      { action: "create", taskId: "task_assigned", status: "in_progress" },
    );
    assert.equal(assignedCreate.status, 200);
    assert.equal(app.snapshot().tasks.find((task) => task.id === "cline-team:task_assigned")?.state, "IN_PROGRESS");

    for (const [id, action, status, expected] of [
      ["task_direct_complete", "complete", "completed", "VERIFYING"],
      ["task_direct_block", "block", "blocked", "FAILED"],
    ] as const) {
      const created = await postTeamTask(
        { action: "create", title: id },
        { action: "create", taskId: id, status: "pending" },
      );
      assert.equal(created.status, 200);
      assert.equal(app.snapshot().tasks.find((task) => task.id === `cline-team:${id}`)?.state, "READY");

      const updated = await postTeamTask(
        { action, taskId: id },
        { action, taskId: id, status },
      );
      assert.equal(updated.status, 200);
      assert.equal(app.snapshot().tasks.find((task) => task.id === `cline-team:${id}`)?.state, expected);

      const duplicate = await postTeamTask(
        { action, taskId: id },
        { action, taskId: id, status },
      );
      assert.equal(duplicate.status, 200);
      assert.equal(app.snapshot().tasks.find((task) => task.id === `cline-team:${id}`)?.state, expected);
    }
  } finally {
    await bridge.close();
  }
});

test("Cline afterTool reports successful team_task mutations to Workflow", async () => {
  const app = application();
  const authority = await createWorkflowClineTuiBridge(app);
  const previousUrl = process.env.WORKFLOW_CLINE_BRIDGE_URL;
  const previousToken = process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
  process.env.WORKFLOW_CLINE_BRIDGE_URL = authority.url;
  process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = authority.token;
  try {
    const hooks = createWorkflowBridge().authorize(undefined);
    const result = await hooks.afterTool?.({
      toolCall: { toolName: "team_task" },
      input: { action: "create", title: "Task from Cline", description: "Observed after execution" },
      result: { output: { action: "create", taskId: "task_0002", status: "pending" } },
    } as never);

    assert.equal(result, undefined);
    assert.equal(app.snapshot().tasks.find((task) => task.id === "cline-team:task_0002")?.title, "Task from Cline");
  } finally {
    if (previousUrl === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_URL;
    else process.env.WORKFLOW_CLINE_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
    else process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = previousToken;
    await authority.close();
  }
});

test("Cline sends the active team task with contained bash requests", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/bash" ? { output: "ok" } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const previousUrl = process.env.WORKFLOW_CLINE_BRIDGE_URL;
  const previousToken = process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
  process.env.WORKFLOW_CLINE_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = "task-binding-test-token";
  try {
    const workflow = createWorkflowBridge();
    const hooks = workflow.authorize(undefined);
    await hooks.afterTool?.({
      toolCall: { toolName: "team_task" },
      input: { action: "claim", taskId: "task_bound" },
      result: { output: { action: "claim", taskId: "task_bound", status: "in_progress" } },
    } as never);
    await workflow.bash("true", process.cwd(), undefined);

    assert.equal(requests.find(({ path }) => path === "/bash")?.body.teamTaskId, "task_bound");
  } finally {
    if (previousUrl === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_URL;
    else process.env.WORKFLOW_CLINE_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
    else process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = previousToken;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ordinary bash cannot certify a named completed team task or start the interactive seed task", async () => {
  const graph = new TaskGraph([workflowTask()]);
  const app = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
  );
  const runs = createRunRegistry(app, graph);
  const bridge = await createWorkflowClineTuiBridge(app, runs.resolve, runs.controller);
  try {
    const post = (input: unknown, result: unknown) => fetch(`${bridge.url}/team-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: process.cwd(), input, result }),
    });
    await post(
      { action: "create", title: "Bound task", assignee: "worker" },
      { action: "create", taskId: "task_bound", status: "in_progress" },
    );
    const response = await fetch(`${bridge.url}/bash`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: process.cwd(), cwd: process.cwd(), command: "true", teamTaskId: "task_bound" }),
    });
    assert.equal(response.status, 200, await response.text());
    const workspaceApp = runs.resolve(process.cwd(), undefined, { activateInteractiveTask: false });
    const boundId = taskId(`cline-team:${encodeURIComponent(workspaceApp.workspaceRoot!)}:task_bound`);
    assert.equal(workspaceApp.snapshot().evidence.some((entry) => entry.subject === boundId && entry.authority === "environment"), false);
    await post(
      { action: "complete", taskId: "task_bound" },
      { action: "complete", taskId: "task_bound", status: "completed" },
    );
    assert.equal(graph.get(boundId).state, "VERIFYING");
    const afterCompletion = await fetch(`${bridge.url}/bash`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: process.cwd(), cwd: process.cwd(), command: "true", teamTaskId: "task_bound" }),
    });
    assert.equal(afterCompletion.status, 200);
    assert.equal(graph.get(taskId("A")).state, "IN_PROGRESS");
    assert.equal(workspaceApp.snapshot().evidence.some((entry) => entry.subject === boundId && entry.authority === "environment"), false);

    const unknown = await fetch(`${bridge.url}/bash`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: process.cwd(), cwd: process.cwd(), command: "true", teamTaskId: "task_unknown" }),
    });
    assert.equal(unknown.status, 500);
  } finally {
    await bridge.close();
  }
});

test("contained bash cannot self-certify a team task even with a matching lifecycle hint", async () => {
  const graph = new TaskGraph([workflowTask()]);
  const app = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
  );
  const runs = createRunRegistry(app, graph);
  const bridge = await createWorkflowClineTuiBridge(app, runs.resolve, runs.controller);
  try {
    const workspace = process.cwd();
    const teamTask = (input: unknown, result: unknown) => fetch(`${bridge.url}/team-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace, input, result }),
    });
    await teamTask(
      { action: "create", title: "Verify with command", assignee: "worker" },
      { action: "create", taskId: "task_command", status: "in_progress" },
    );

    const command = await fetch(`${bridge.url}/bash`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace, cwd: workspace, command: "true", teamTaskId: "task_command" }),
    });
    assert.equal(command.status, 200, await command.text());

    const completed = await teamTask(
      { action: "complete", taskId: "task_command" },
      { action: "complete", taskId: "task_command", status: "completed" },
    );
    assert.equal(completed.status, 200);
    const workspaceApp = runs.resolve(workspace, undefined, { activateInteractiveTask: false });
    const canonicalId = taskId(`cline-team:${encodeURIComponent(workspaceApp.workspaceRoot!)}:task_command`);
    assert.equal(graph.get(canonicalId).state, "VERIFYING");
    assert.equal(workspaceApp.snapshot().evidence.some((entry) => entry.subject === canonicalId && entry.authority === "environment"), false);
    assert.equal(graph.get(taskId("A")).state, "READY");
  } finally {
    await bridge.close();
  }
});

test("Workflow-owned verification command promotes a completed Cline team task", async () => {
  const app = application(process.cwd());
  const bridge = await createWorkflowClineTuiBridge(app, undefined, undefined, undefined, "true");
  try {
    await syncCompletedTeamTask(bridge, "task_workflow_verified");
    const id = taskId(`cline-team:${encodeURIComponent(process.cwd())}:task_workflow_verified`);
    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFIED");
    assert.ok(app.snapshot().evidence.some((entry) => entry.subject === id && entry.authority === "environment" && entry.result === "passed"));
  } finally {
    await bridge.close();
  }
});

test("failed Workflow-owned verification leaves a completed Cline team task verifying", async () => {
  const app = application(process.cwd());
  const bridge = await createWorkflowClineTuiBridge(app, undefined, undefined, undefined, "false");
  try {
    await syncCompletedTeamTask(bridge, "task_workflow_failed");
    const id = taskId(`cline-team:${encodeURIComponent(process.cwd())}:task_workflow_failed`);
    assert.equal(app.snapshot().tasks.find((task) => task.id === id)?.state, "VERIFYING");
    assert.ok(app.snapshot().evidence.some((entry) => entry.subject === id && entry.authority === "environment" && entry.result === "failed"));
  } finally {
    await bridge.close();
  }
});

test("Cline afterTool retries team_task synchronization and fails closed after three attempts", async () => {
  let requests = 0;
  let failuresRemaining = 2;
  const server = createServer((_request, response) => {
    requests += 1;
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporary failure" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const previousUrl = process.env.WORKFLOW_CLINE_BRIDGE_URL;
  const previousToken = process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
  process.env.WORKFLOW_CLINE_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = "retry-test-token";
  try {
    const hooks = createWorkflowBridge().authorize(undefined);
    const context = {
      toolCall: { toolName: "team_task" },
      input: { action: "claim", taskId: "task_retry" },
      result: { output: { action: "claim", taskId: "task_retry", status: "in_progress" } },
    } as never;
    assert.equal(await hooks.afterTool?.(context), undefined);
    assert.equal(requests, 3);

    requests = 0;
    failuresRemaining = 3;
    const failed = await hooks.afterTool?.(context);
    assert.equal(requests, 3);
    assert.equal(failed?.stop, true);
    assert.match(failed?.reason ?? "", /Workflow task synchronization failed: temporary failure/);
  } finally {
    if (previousUrl === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_URL;
    else process.env.WORKFLOW_CLINE_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.WORKFLOW_CLINE_BRIDGE_TOKEN;
    else process.env.WORKFLOW_CLINE_BRIDGE_TOKEN = previousToken;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Cline TUI snapshot polling does not start interactive work", async () => {
  const graph = new TaskGraph([workflowTask()]);
  const app = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
  );
  const runs = createRunRegistry(app, graph);
  const bridge = await createWorkflowClineTuiBridge(app, runs.resolve, runs.controller);
  try {
    const response = await fetch(`${bridge.url}/snapshot`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspace: process.cwd() }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { snapshot: { tasks: Array<{ state: string }> } };
    assert.equal(payload.snapshot.tasks[0]?.state, "READY");
    assert.throws(
      () => runs.resolve(process.cwd(), undefined, { activateInteractiveTask: false }).activeTaskId(),
      /no active workflow task selected/,
    );
  } finally {
    await bridge.close();
  }
});

test("Cline TUI snapshots hide finished scheduled runs without deleting canonical state", async () => {
  const graph = new TaskGraph([workflowTask()]);
  const app = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
  );
  const runs = createRunRegistry(app, graph);
  const bridge = await createWorkflowClineTuiBridge(app, runs.resolve, runs.controller);
  try {
    await runs.controller.begin({ runId: "completed-run", title: "Completed scheduled run", workspace: process.cwd() });
    await runs.controller.finish({ runId: "completed-run", outcome: "verified" });

    assert.equal(graph.get(taskId("run:completed-run")).state, "VERIFIED");
    const response = await fetch(`${bridge.url}/snapshot`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspace: process.cwd() }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { snapshot: { tasks: Array<{ id: string }> } };
    assert.equal(payload.snapshot.tasks.some((task) => task.id === "run:completed-run"), false);
  } finally {
    await bridge.close();
  }
});

test("Cline TUI snapshots hide failed scheduled runs without deleting canonical state", async () => {
  const graph = new TaskGraph([workflowTask()]);
  const app = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
  );
  const runs = createRunRegistry(app, graph);
  const bridge = await createWorkflowClineTuiBridge(app, runs.resolve, runs.controller);
  try {
    await runs.controller.begin({ runId: "failed-run", title: "Failed scheduled run", workspace: process.cwd() });
    await runs.controller.finish({ runId: "failed-run", outcome: "failed" });

    assert.equal(graph.get(taskId("run:failed-run")).state, "FAILED");
    const response = await fetch(`${bridge.url}/snapshot`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspace: process.cwd() }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { snapshot: { tasks: Array<{ id: string }> } };
    assert.equal(payload.snapshot.tasks.some((task) => task.id === "run:failed-run"), false);
  } finally {
    await bridge.close();
  }
});

async function syncCompletedTeamTask(
  bridge: Awaited<ReturnType<typeof createWorkflowClineTuiBridge>>,
  clineTaskId: string,
): Promise<void> {
  const post = (input: unknown, result: unknown) => fetch(`${bridge.url}/team-task`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace: process.cwd(), input, result }),
  });
  const created = await post(
    { action: "create", title: clineTaskId },
    { action: "create", taskId: clineTaskId, status: "pending" },
  );
  assert.equal(created.status, 200);
  const completed = await post(
    { action: "complete", taskId: clineTaskId },
    { action: "complete", taskId: clineTaskId, status: "completed" },
  );
  assert.equal(completed.status, 200);
}

function application(workspaceRoot?: string): WorkflowApplication {
  return new WorkflowApplication(
    new TaskGraph([workflowTask()]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspaceRoot,
  );
}

function workflowTask(): WorkflowTask {
  return {
    id: taskId("A"),
    title: "Interactive task",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  };
}
