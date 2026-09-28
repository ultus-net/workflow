import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  createProjectRegistry,
  type ProjectRecord,
} from "../src/integrations/project-registry.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W164 — the hub's project-container routes. Mirrors the /schedule/* route
// contract (operator-token class, 404 when the registry is absent, client-
// fault 400s, persist-before-admit) and pins the spec's accept criteria at
// the wire level:
//   - the identity record provably carries no credential ON THE WIRE — a
//     hostile save body carrying a token-shaped key must neither persist nor
//     echo it (pinned by value);
//   - per-project scoping: /project/scope answers ONLY the bound workspaces
//     and the repo-bound board — a foreign repo's board is refused by name;
//   - single-authority dispatch preserved: project mutations never touch the
//     application's task state (snapshot pinned identical before/after), and
//     the routes expose no run seam.

const TOKEN = "ghp_wire-seeded-cr3dential-4e9b";

interface Bridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

const seat = (context: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "wf-project-routes-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function compose(
  context: TestContext,
  options: { readonly withBoard?: boolean } = {},
): Promise<{ bridge: Bridge; registry: ReturnType<typeof createProjectRegistry>; application: WorkflowApplication }> {
  const task: WorkflowTask = {
    id: taskId("seed"),
    title: "seed",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  };
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const registry = createProjectRegistry({ path: join(seat(context), "projects.json") });
  const boardOutcome = {
    state: "ok",
    board: {
      provider: "github",
      repo: "ultus-net/workflow",
      tasks: [{
        provider: "github", key: "#7", title: "a task", state: "open",
        url: "https://github.com/ultus-net/workflow/issues/7", labels: [], updatedAt: "2026-09-26T00:00:00Z",
      }],
      skipped: 0,
      pullRequestsExcluded: 0,
    },
  } as const;
  const bridge = await createWorkflowHubBridge(
    application,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ...(options.withBoard === true ? { readBoardTasks: async () => boardOutcome } : {}),
      projects: registry,
    },
  );
  context.after(() => bridge.close());
  return { bridge, registry, application };
}

const call = async (bridge: Bridge, path: string, token: string, body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> => {
  const response = await fetch(`${bridge.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
};

const validProject: ProjectRecord = {
  id: "workflow",
  title: "Workflow",
  repo: { provider: "github", fullName: "ultus-net/workflow", repoId: 911_496_128 },
  status: "active",
  workspaces: ["/ws/workflow"],
};

test("W164: /project/* rides the operator-token class — the verifier credential is not the operator token", async (context) => {
  const { bridge } = await compose(context);
  const denied = await call(bridge, "/project/list", "f".repeat(64), {});
  assert.equal(denied.status, 401);
  // The verifier token authorizes /run/finish — it must NOT authorize the
  // project table: different credential classes, different blast radii.
  const verifier = await call(bridge, "/project/list", bridge.verificationToken, {});
  assert.equal(verifier.status, 401);
  const answered = await call(bridge, "/project/list", bridge.token, {});
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.payload, { projects: [] });
});

test("W164: save → list → delete round trip; unknown client keys are stripped before the registry persists them", async (context) => {
  const { bridge, registry } = await compose(context);
  const saved = await call(bridge, "/project/save", bridge.token, {
    ...validProject,
    // A hostile client tries to smuggle credential-shaped and dispatch-shaped
    // fields; the route persists the schema and nothing else.
    token: TOKEN,
    apiKey: "sk-anything",
    dispatch: "run everything",
    runId: "run:ghost",
  });
  assert.equal(saved.status, 200);
  const listed = await call(bridge, "/project/list", bridge.token, {});
  assert.equal(listed.status, 200);
  const projects = listed.payload.projects as Record<string, unknown>[];
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0], validProject);
  // By value: neither the wire nor the registry at rest ever carries it.
  assert.ok(!JSON.stringify(listed.payload).includes(TOKEN));
  assert.ok(!JSON.stringify(registry.list()).includes(TOKEN));
  const removed = await call(bridge, "/project/delete", bridge.token, { id: "workflow" });
  assert.equal(removed.status, 200);
  assert.deepEqual((removed.payload.projects as unknown[]).length, 0);
  // Deleting an unknown id answers 200 with the table unchanged (the
  // schedule route's contract).
  const unknown = await call(bridge, "/project/delete", bridge.token, { id: "nope" });
  assert.equal(unknown.status, 200);
});

test("W164: an invalid record is a client fault (400) and never partially admits", async (context) => {
  const { bridge } = await compose(context);
  const saved = await call(bridge, "/project/save", bridge.token, { ...validProject, repo: { provider: "github", fullName: "not-a-pair", repoId: 1 } });
  assert.equal(saved.status, 400);
  assert.match(String(saved.payload.error), /fullName/);
  const listed = await call(bridge, "/project/list", bridge.token, {});
  assert.deepEqual(listed.payload.projects, []);
});

test("W164: a hub composed without the registry 404s the project routes — fail closed", async (context) => {
  const task: WorkflowTask = {
    id: taskId("seed"),
    title: "seed",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  };
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const bridge = await createWorkflowHubBridge(application);
  context.after(() => bridge.close());
  for (const path of ["/project/list", "/project/save", "/project/delete", "/project/scope"]) {
    const result = await call(bridge, path, bridge.token, {});
    assert.equal(result.status, 404, path);
  }
});

test("W164: /project/scope answers ONLY the bound workspaces and the repo-bound board", async (context) => {
  const { bridge, registry } = await compose(context, { withBoard: true });
  registry.save(validProject as never);
  const scoped = await call(bridge, "/project/scope", bridge.token, { id: "workflow" });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.payload.workspaces, ["/ws/workflow"]);
  assert.deepEqual((scoped.payload.project as Record<string, unknown>).repo, { provider: "github", fullName: "ultus-net/workflow", repoId: 911_496_128 });
  // The board is bound: the provider outcome rides only when its repo is the
  // project's own identity.
  assert.deepEqual(scoped.payload.board, {
    state: "ok",
    board: {
      provider: "github",
      repo: "ultus-net/workflow",
      tasks: [{
        provider: "github", key: "#7", title: "a task", state: "open",
        url: "https://github.com/ultus-net/workflow/issues/7", labels: [], updatedAt: "2026-09-26T00:00:00Z",
      }],
      skipped: 0,
      pullRequestsExcluded: 0,
    },
  });

  // A second project bound to a different repo never receives the other
  // repo's board — the refusal NAMES both identities.
  registry.save({ ...validProject, id: "other", repo: { provider: "github", fullName: "other/repo", repoId: 2 } });
  const foreign = await call(bridge, "/project/scope", bridge.token, { id: "other" });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.payload.board, null);
  assert.match(String(foreign.payload.reason), /other\/repo/);
  assert.match(String(foreign.payload.reason), /ultus-net\/workflow/);

  // Unknown id → honest 404; no board closure → board null with the reason.
  const unknown = await call(bridge, "/project/scope", bridge.token, { id: "nope" });
  assert.equal(unknown.status, 404);
  const { bridge: bare, registry: bareRegistry } = await compose(context);
  bareRegistry.save(validProject as never);
  const noBoard = await call(bare, "/project/scope", bare.token, { id: "workflow" });
  assert.equal(noBoard.status, 200);
  assert.equal(noBoard.payload.board, null);
  assert.match(String(noBoard.payload.reason), /board/);
});

test("W164: single-authority dispatch preserved — project mutations never move the application's task state", async (context) => {
  const { bridge, application } = await compose(context, { withBoard: true });
  const before = application.snapshot();
  await call(bridge, "/project/save", bridge.token, { ...validProject, token: TOKEN });
  await call(bridge, "/project/delete", bridge.token, { id: "workflow" });
  await call(bridge, "/project/scope", bridge.token, { id: "workflow" });
  const after = application.snapshot();
  assert.deepEqual(
    after.tasks.map((task) => ({ id: task.id, state: task.state })),
    before.tasks.map((task) => ({ id: task.id, state: task.state })),
  );
  assert.equal(after.history.length, before.history.length, "no kernel transition was recorded by a project route");
});
