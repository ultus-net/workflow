import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { taskId } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { readHubWebEndpoint } from "../src/integrations/hub-discovery.js";
import { hubWebDiscoveryPath, removeHubWebDiscovery, writeHubWebDiscovery } from "../src/integrations/hub-web-discovery.js";
import { startHubWebUi } from "../src/cli/web-service.js";

/**
 * C1 hub endpoint (D5): the in-plane hub UI composition + its discovery file.
 *
 * The single-writer point: `startHubWebUi` serves a GIVEN application (the
 * hub's own), not a fresh demo graph — this test proves the served snapshot is
 * the passed application's, and that the UI answers its honest management-only
 * state (no session manager) rather than crashing.
 */

function applicationWith(taskTitle: string, workspace: string): WorkflowApplication {
  return new WorkflowApplication(
    new TaskGraph([
      { id: taskId("interactive"), title: taskTitle, state: "READY", dependencies: [], requiredEvidence: [] },
    ]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
}

test("startHubWebUi serves the PASSED application's snapshot (the hub's own, never a demo graph)", async () => {
  const application = applicationWith("The hub's canonical task", process.cwd());
  const ui = await startHubWebUi(application);
  try {
    // /api/snapshot is the one local-authority read; it must reflect the given app.
    const response = await fetch(`${ui.url}/api/snapshot`);
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as { tasks?: { title?: string }[] };
    const titles = (snapshot.tasks ?? []).map((task) => task.title);
    assert.ok(titles.includes("The hub's canonical task"), `snapshot carries the given app's task, got ${JSON.stringify(titles)}`);
    assert.ok(!titles.includes("Inspect the browser Workflow UI"), "the demo graph's task is absent");
    // The root serves the operator UI.
    const root = await fetch(`${ui.url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    // No session manager: the session route answers its honest 503, not a crash.
    const sessions = await fetch(`${ui.url}/api/sessions`);
    assert.equal(sessions.status, 503);
  } finally {
    await ui.close();
  }
});

test("startHubWebUi answers the workspace-confined git route from the application", async () => {
  const application = applicationWith("task", process.cwd());
  const ui = await startHubWebUi(application);
  try {
    // /api/git reads application.workspaceRoot; in this repo it resolves a branch.
    const response = await fetch(`${ui.url}/api/git`);
    assert.ok(response.status === 200 || response.status === 503, `git route answered a defined status, got ${response.status}`);
  } finally {
    await ui.close();
  }
});

test("the hub web discovery round-trips and fails closed when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hubweb-"));
  try {
    const hubDiscovery = join(dir, "hub", "discovery.json");
    assert.equal(hubWebDiscoveryPath(hubDiscovery), join(dir, "hub", "web.json"));
    assert.equal(readHubWebEndpoint(dir), undefined, "no file → undefined (withheld, never fabricated)");
    writeHubWebDiscovery(hubDiscovery, "http://127.0.0.1:7777");
    assert.equal(readHubWebEndpoint(dir), "http://127.0.0.1:7777");
    assert.ok(existsSync(hubWebDiscoveryPath(hubDiscovery)));
    removeHubWebDiscovery(hubDiscovery);
    assert.equal(readHubWebEndpoint(dir), undefined, "removed → undefined again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHubWebEndpoint withholds a corrupt or non-loopback endpoint (fail closed, never a forwarded 500)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hubweb-bad-"));
  try {
    const webPath = join(dir, "hub", "web.json");
    mkdirSync(join(dir, "hub"), { recursive: true });
    for (const bad of [
      JSON.stringify({ protocol: 1, endpoint: "not-a-url" }),
      JSON.stringify({ protocol: 1, endpoint: "http://10.0.0.5:1234" }),
      JSON.stringify({ protocol: 1, endpoint: "https://127.0.0.1:1234" }),
      JSON.stringify({ protocol: 1 }), // no endpoint
      "not json",
    ]) {
      writeFileSync(webPath, bad);
      assert.equal(readHubWebEndpoint(dir), undefined, `expected ${bad} to be withheld`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
