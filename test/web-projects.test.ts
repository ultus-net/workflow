import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { createProjectRegistry } from "../src/integrations/project-registry.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";
import { createWorkflowWebServer } from "../src/ui/web.js";

// W164 — the project container's operator surfaces through the web service:
// the browser reaches the hub's project table via /api proxies only. The hub
// is the single writer; the proxy relays the operator-token class and strips
// the browser payload to the project schema (the schedules-proxy pattern).
// The board-scoping UI interaction is a recorded deferral (the hub's
// /project/scope answers the scoped read; the Projects page lists records
// and never launches anything).

const tasks: WorkflowTask[] = [
  { id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
];

async function listen(server: ReturnType<typeof createWorkflowWebServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const project = {
  id: "workflow",
  title: "Workflow",
  repo: { provider: "github", fullName: "ultus-net/workflow", repoId: 911_496_128 },
  status: "active",
  workspaces: ["/ws/workflow"],
};

test("W164: the web service proxies the hub's project table — save strips to the schema, delete guards cross-origin, no hub is honest", async (context) => {
  const hubDir = mkdtempSync(join(tmpdir(), "wf-web-projects-"));
  context.after(() => rmSync(hubDir, { recursive: true, force: true }));

  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
    hubDir,
  );
  const projects = createProjectRegistry({ path: join(hubDir, "projects.json") });
  const hub = await createWorkflowHub(application, { discoveryDir: hubDir, graph, projects });
  context.after(() => hub.close());

  const webApplication = new WorkflowApplication(
    new TaskGraph(tasks.map((task) => ({ ...task }))),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: hubDir });
  const port = await listen(server);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${port}`;

  // An empty table lists honestly, then the save round-trips.
  const empty = await fetch(`${base}/api/projects`).then((r) => r.json() as Promise<{ projects: unknown[] }>);
  assert.deepEqual(empty.projects, []);
  const saved = await fetch(`${base}/api/projects/save`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    // Injected keys and a credential-shaped key must never persist: the
    // proxy strips to the schema and the hub route composes from validated
    // fields only.
    body: JSON.stringify({ ...project, injected: true, token: "ghp_should-never-persist" }),
  });
  assert.equal(saved.status, 200);
  const listed = await fetch(`${base}/api/projects`).then((r) => r.json() as Promise<{ projects: Array<Record<string, unknown>> }>);
  assert.equal(listed.projects.length, 1);
  assert.deepEqual(listed.projects[0], project);
  assert.equal((listed.projects[0] as Record<string, unknown>).injected, undefined, "unknown client keys are stripped before the hub persists them");
  assert.ok(!JSON.stringify(listed.projects).includes("ghp_should-never-persist"), "the credential-shaped key never round-trips");

  // The budget envelope survives the edit round trip (the base spread).
  const withBudget = await fetch(`${base}/api/projects/save`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ ...project, budget: { maxCostUsd: 2.5 }, workspaces: ["/ws/workflow", "/ws/workflow-lib"] }),
  });
  assert.equal(withBudget.status, 200);
  const enriched = await fetch(`${base}/api/projects`).then((r) => r.json() as Promise<{ projects: Array<{ budget?: unknown; workspaces: string[] }> }>);
  assert.deepEqual(enriched.projects[0]?.budget, { maxCostUsd: 2.5 }, "the budget envelope survives the browser edit round-trip");
  assert.deepEqual(enriched.projects[0]?.workspaces, ["/ws/workflow", "/ws/workflow-lib"]);

  // Cross-origin mutations are refused, like every other browser mutation.
  const crossOrigin = await fetch(`${base}/api/projects/delete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ id: "workflow" }),
  });
  assert.equal(crossOrigin.status, 403);
  const stillThere = await fetch(`${base}/api/projects`).then((r) => r.json() as Promise<{ projects: unknown[] }>);
  assert.equal(stillThere.projects.length, 1);

  const deleted = await fetch(`${base}/api/projects/delete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ id: "workflow" }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/projects`)).json() as { projects: unknown[] }).projects, []);

  // A missing hub means 503, never a fabricated list.
  const orphanServer = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: mkdtempSync(join(tmpdir(), "wf-web-projects-orphan-")) });
  const orphanPort = await listen(orphanServer);
  context.after(() => new Promise<void>((resolve) => orphanServer.close(() => resolve())));
  const orphan = await fetch(`http://127.0.0.1:${orphanPort}/api/projects`);
  assert.equal(orphan.status, 503);
});
