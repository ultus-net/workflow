import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { WorkflowCodingSession, type CodingSessionDriver } from "../src/application/coding-session.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import type { WorkflowAcpRuntime } from "../src/integrations/acp-runtime.js";
import { createWorkflowWebServer } from "../src/ui/web.js";
import { WebSessionManager } from "../src/ui/web-sessions.js";

// HTTP-level coverage for the agent-switch endpoints (GET /api/agents and
// POST /api/sessions/agent): the registry listing and the 403/415/400/503/200
// branches that manager-level tests cannot reach.

function fakeRuntime(agentId: string | undefined): WorkflowAcpRuntime {
  const driver = {
    start: async (_prompt: unknown, emit: (event: unknown) => void) => {
      emit({ type: "assistant", text: "done" });
      emit({ type: "completed", result: "done" });
    },
    cancel: async () => {},
    agentSessionId: () => agentId,
    connect: async () => {},
    subscribe: () => () => {},
  };
  return {
    driver: driver as unknown as WorkflowAcpRuntime["driver"],
    session: new WorkflowCodingSession(driver as unknown as CodingSessionDriver),
    budgetMechanism: "test: no local caps (fake runtime)",
    async dispose() {},
  };
}

function application(): WorkflowApplication {
  const tasks: WorkflowTask[] = [{ id: taskId("A"), title: "Task", state: "READY", dependencies: [], requiredEvidence: [] }];
  return new WorkflowApplication(new TaskGraph(tasks), hostCapabilities({ transport: "acp", authoritativePreMutation: false }));
}

async function listen(server: ReturnType<typeof createWorkflowWebServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const post = (url: string, init: { contentType?: string; body?: string; origin?: string }): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      ...(init.contentType !== undefined ? { "content-type": init.contentType } : {}),
      ...(init.origin !== undefined ? { origin: init.origin } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });

test("GET /api/agents lists the registered agents, default first", async (context) => {
  const server = createWorkflowWebServer(application());
  context.after(() => server.close());
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/agents`);
  assert.equal(response.status, 200);
  const body = await response.json() as { agents: { id: string; containment: string }[] };
  assert.deepEqual(body.agents.map((agent) => agent.id), ["opencode", "goose", "cline"]);
  assert.equal(body.agents[0]?.containment, "advisory");
  assert.equal(body.agents[1]?.containment, "contained");
  assert.equal(body.agents[2]?.containment, "contained");
});

test("POST /api/sessions/agent returns 503 when no session manager is wired", async (context) => {
  const server = createWorkflowWebServer(application());
  context.after(() => server.close());
  const port = await listen(server);
  const response = await post(`http://127.0.0.1:${port}/api/sessions/agent`, { contentType: "application/json", body: JSON.stringify({ agent: "opencode" }) });
  assert.equal(response.status, 503);
});

test("POST /api/sessions/agent guards origin, content-type, and agent id, then switches", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "web-agent-endpoint-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const launches: string[] = [];
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async (agent) => { launches.push(agent); return fakeRuntime(`${agent}-session`); },
  });
  const server = createWorkflowWebServer(application(), manager);
  context.after(() => { server.close(); });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/api/sessions/agent`;

  // Cross-site origin is an untrusted mutation → 403.
  const crossSite = await post(url, { contentType: "application/json", body: JSON.stringify({ agent: "cline" }), origin: "http://evil.example" });
  assert.equal(crossSite.status, 403);
  // Non-JSON content type → 415.
  const wrongType = await post(url, { contentType: "text/plain", body: "agent=cline" });
  assert.equal(wrongType.status, 415);
  // Unknown agent id → 400.
  const unknown = await post(url, { contentType: "application/json", body: JSON.stringify({ agent: "not-an-agent" }) });
  assert.equal(unknown.status, 400);

  // A valid switch re-launches the active session on the requested agent.
  await manager.channel();
  const ok = await post(url, { contentType: "application/json", body: JSON.stringify({ agent: "cline" }) });
  assert.equal(ok.status, 200);
  assert.ok(launches.includes("cline"), "the manager re-launched on the requested agent");
  await manager.dispose();
});

// W082: operator-triggered compaction (POST /api/session/{agentSessionId}/
// compact through the enforced gateway). The workflow session id selects the
// manager record; the AGENT's v2 session id is what the route takes. Honest
// branches only: without a manager, without an agent session, and without a
// server topology — a live-gateway admit is pinned at the live-state layer.
test("POST /api/sessions/compact: honest refusals without a manager, an agent session, or a topology", async (context) => {
  // No manager wired → the honest capability message.
  const bare = createWorkflowWebServer(application());
  context.after(() => bare.close());
  const barePort = await listen(bare);
  const bareUrl = `http://127.0.0.1:${barePort}/api/sessions/compact`;
  const bareResponse = await post(bareUrl, { contentType: "application/json", body: JSON.stringify({ id: "whatever" }) });
  assert.equal(bareResponse.status, 409);
  assert.match((await bareResponse.json() as { error: string }).error, /parallel session manager/);

  const dir = mkdtempSync(join(tmpdir(), "web-compact-endpoint-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async (agent) => fakeRuntime(`ses_${agent}_1`),
  });
  const server = createWorkflowWebServer(application(), manager);
  context.after(() => server.close());
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/api/sessions/compact`;

  // Cross-site origin is an untrusted mutation → 403.
  const crossSite = await post(url, { contentType: "application/json", body: JSON.stringify({ id: "x" }), origin: "http://evil.example" });
  assert.equal(crossSite.status, 403);
  // Non-JSON content type → 415; missing id → 400.
  const wrongType = await post(url, { contentType: "text/plain", body: "id=x" });
  assert.equal(wrongType.status, 415);
  const missingId = await post(url, { contentType: "application/json", body: JSON.stringify({}) });
  assert.equal(missingId.status, 400);

  // An established runtime (fake driver reports a ses_… id) with no server
  // topology → the gateway walk's honest unavailability reason, mapped to 503
  // like the sibling unavailable reads (W082 review P3). create() spawns the
  // runtime immediately, so the compact path goes straight to the walk.
  const created = await manager.create();
  assert.equal(created.kind, "ok");
  if (created.kind !== "ok") return;
  const compact = await post(url, { contentType: "application/json", body: JSON.stringify({ id: created.meta.id }) });
  assert.equal(compact.status, 503);
  assert.match((await compact.json() as { reason: string }).reason, /no server topology daemon.*compaction/s);
  await manager.dispose();

  // A driver that never established an agent session → the honest "send a
  // message first" refusal (the runtime spawned, but its driver has no agent
  // session id yet).
  const noSessionManager = new WebSessionManager({
    registryPath: join(dir, "registry-2.json"),
    factory: async () => fakeRuntime(undefined),
  });
  const second = createWorkflowWebServer(application(), noSessionManager);
  context.after(() => second.close());
  const secondPort = await listen(second);
  const secondUrl = `http://127.0.0.1:${secondPort}/api/sessions/compact`;
  const secondCreated = await noSessionManager.create();
  assert.equal(secondCreated.kind, "ok");
  if (secondCreated.kind !== "ok") return;
  const noAgentSession = await post(secondUrl, { contentType: "application/json", body: JSON.stringify({ id: secondCreated.meta.id }) });
  assert.equal(noAgentSession.status, 409);
  assert.match((await noAgentSession.json() as { error: string }).error, /no agent session yet/);
  await noSessionManager.dispose();
});
