import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";
import { canonicalWorkspace } from "../src/integrations/run-registry.js";

/**
 * Per-surface workspace binding: surfaces declare their workspace per request
 * and the hub resolves it against the declared workspace rather than the hub
 * daemon's own cwd. See docs/HUB_PROTOCOL.md §3.
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

async function snapshot(url: string, token: string, body: unknown) {
  const response = await fetch(`${url}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("hub fails closed on an invalid workspace declaration", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => hub.close());
  const token = hubToken(hub.discoveryPath);

  // W146 residual (the review's P3): /snapshot reaches the SAME
  // canonicalWorkspace refusal as /bash and /run/begin, so a non-canonical
  // workspace declaration is a CLIENT fault answered 400 with the named
  // message — never the catch-all's 500. The prior pin only asserted
  // `notEqual(200)`, which let the client fault ride the server-fault shape
  // unobserved.
  const relative = await snapshot(hub.url, token, { workspace: "relative/path" });
  assert.equal(relative.status, 400, "a relative workspace declaration is a client fault (400), not a server fault");
  assert.match(String(relative.body.error), /must be absolute/, "the refusal names the requirement");

  const missingPath = join(tmpdir(), "wf-no-such-dir-" + Math.random().toString(16).slice(2));
  const missing = await snapshot(hub.url, token, { workspace: missingPath });
  assert.equal(missing.status, 400, "a non-existent workspace declaration is a client fault (400), not a server fault");
  assert.match(String(missing.body.error), /not an existing directory/, "the refusal names the requirement");
});

test("canonicalWorkspace canonicalizes aliases to one real path", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "wf-hub-canon-"));
  const real = join(parent, "workspace");
  const alias = join(parent, "alias");
  mkdirSync(real);
  symlinkSync(real, alias);
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  assert.equal(canonicalWorkspace(alias), realpathSync(real));
  assert.equal(canonicalWorkspace(real), canonicalWorkspace(alias));
});

test("hub protects and removes verifier discovery on shutdown", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph });
  assert.equal(statSync(hub.verifierDiscoveryPath).mode & 0o777, 0o600);
  await hub.close();
  assert.equal(existsSync(hub.verifierDiscoveryPath), false);
});

test("W183: hub tokens are generation-bound and a pre-restart token is rejected", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-generation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  const first = await createWorkflowHub(application, { discoveryDir: dir, graph });
  const firstDiscovery = JSON.parse(readFileSync(first.discoveryPath, "utf8")) as { token: string; generation: string };
  const firstVerifier = JSON.parse(readFileSync(first.verifierDiscoveryPath, "utf8")) as { token: string; generation: string };
  assert.equal(firstDiscovery.generation, first.generation);
  assert.equal(firstVerifier.generation, first.generation);
  assert.match(firstDiscovery.token, new RegExp(`^${first.generation}\\.`));
  // The pre-restart tokens authenticate against the live first hub...
  assert.equal((await snapshot(first.url, firstDiscovery.token, {})).status, 200);
  await first.close();

  const second = await createWorkflowHub(application, { discoveryDir: dir, graph });
  t.after(() => second.close());
  assert.notEqual(second.generation, first.generation);
  const secondDiscovery = JSON.parse(readFileSync(second.discoveryPath, "utf8")) as { token: string; generation: string };
  assert.equal(secondDiscovery.generation, second.generation);

  // ...and are rejected after the restart, even though the loopback endpoint
  // is still a live hub. The generation binding is enforced at authorization
  // (unit-pinned in test/hub-tokens.test.ts): the pre-restart token carries a
  // generation that is not the live one, so it fails the binding before the
  // constant-time digest comparison.
  assert.equal((await snapshot(second.url, firstDiscovery.token, {})).status, 401);
  assert.equal((await snapshot(second.url, firstVerifier.token, {})).status, 401);
  assert.equal((await snapshot(second.url, secondDiscovery.token, {})).status, 200);
});


test("hub cleans up a partially started bridge when verifier discovery cannot publish", async (t) => {
  const { graph, application, hubRoot } = setup();
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-discovery-"));
  const hubDir = join(dir, "hub");
  const discoveryPath = join(hubDir, "discovery.json");
  const verifierPath = join(hubDir, "verifier.json");
  let startedBridgeUrl: string | undefined;
  mkdirSync(verifierPath, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(hubRoot, { recursive: true, force: true }));

  await assert.rejects(createWorkflowHub(application, {
    discoveryDir: dir,
    graph,
    observeBridgeStarted: (url) => { startedBridgeUrl = url; },
  }));
  assert.equal(existsSync(discoveryPath), false);
  assert.equal(statSync(verifierPath).isDirectory(), true);
  assert.ok(startedBridgeUrl);
  await assert.rejects(fetch(`${startedBridgeUrl}/health`, { method: "POST" }));

  rmSync(verifierPath, { recursive: true });
  const restarted = await createWorkflowHub(application, { discoveryDir: dir, graph });
  await restarted.close();
});

function hubToken(discoveryPath: string): string {
  return (JSON.parse(readFileSync(discoveryPath, "utf8")) as { token: string }).token;
}
