import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";

/**
 * SDK-neutrality conformance suite: a generic agent-SDK client that talks to
 * the Workflow hub using only the documented protocol (docs/HUB_PROTOCOL.md)
 * — plain HTTP, the discovery file, and no Cline-derived code.
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "task", state: "READY", dependencies: [], requiredEvidence: [] }];

async function withHub(run: (hub: { url: string; discovery: Record<string, unknown> }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-protocol-"));
  const app = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
  const hub = await createWorkflowHub(app, { discoveryDir: dir });
  try {
    const discovery = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8")) as Record<string, unknown>;
    await run({ url: hub.url, discovery });
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function postJson(url: string, token: string | undefined, path: string, body: unknown = {}) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("discovery file matches the documented schema", async () => {
  await withHub(async ({ discovery }) => {
    assert.equal(discovery.protocol, 1);
    assert.match(discovery.hubId as string, /^[0-9a-f]{16}$/);
    assert.match(discovery.endpoint as string, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(discovery.token as string, /^[0-9a-f]{64}$/);
  });
});

test("hub requires the bearer token before routing on every endpoint", async () => {
  await withHub(async ({ url }) => {
    assert.equal((await postJson(url, undefined, "/bash", {})).status, 401);
    assert.equal((await postJson(url, "wrong-token", "/bash", {})).status, 401);
    // Auth is enforced before route resolution: an unknown route with no token
    // is 401, not 404.
    assert.equal((await postJson(url, undefined, "/before-tool", {})).status, 401);
    const bash = await fetch(`${url}/bash`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bash.status, 401);
  });
});

test("hub rejects malformed and unknown requests", async () => {
  await withHub(async ({ url, discovery }) => {
    const token = discovery.token as string;
    const malformed = await fetch(`${url}/bash`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(malformed.status, 400); // a /bash request without cwd/command fails closed

    const unknown = await fetch(`${url}/does-not-exist`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unknown.status, 404);
  });
});

test("closing the hub removes the discovery file (stale hubs cannot be resolved)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-protocol-"));
  const app = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
  const hub = await createWorkflowHub(app, { discoveryDir: dir });
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(resolveHubDiscoveryPath(dir)));
  await hub.close();
  assert.equal(existsSync(resolveHubDiscoveryPath(dir)), false);
  rmSync(dir, { recursive: true, force: true });
});
