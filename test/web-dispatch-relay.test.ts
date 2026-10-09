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
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";
import { createWorkflowWebServer } from "../src/ui/web.js";

/**
 * C1 deploy plan §2.c (the browser relay) — the web service's same-origin
 * proxies for the hub's operator-token dispatch routes:
 *   POST /api/dispatch/azure-job           -> hub POST /dispatch/azure-job
 *   POST /api/dispatch/azure-job/validate  -> hub POST /dispatch/azure-job/validate
 *
 * Pins, mirroring the `/api/board/delegate` relay and the schedules relay:
 *   1. the browser never holds a hub token — the proxy attaches it, and the
 *      upstream hub route is operator-token class (a direct call without the
 *      token is 401);
 *   2. the full task-spec message is forwarded VERBATIM (the hub is the
 *      structural validator, its 400 passes through unchanged);
 *   3. a non-object dispatch body is a 400 at the proxy, never a forwarded
 *      queue write;
 *   4. the validate proxy forwards only a string taskId and passes the hub's
 *      verdict through unchanged;
 *   5. cross-origin mutations are 403 and a non-JSON content-type is 415 (the
 *      shared mutation guards);
 *   6. a missing hub answers 503 ("hub unavailable"), never a fabricated
 *      success.
 */

const tasks: WorkflowTask[] = [
  { id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
];

async function listen(server: ReturnType<typeof createWorkflowWebServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function applicationFixture(): WorkflowApplication {
  return new WorkflowApplication(
    new TaskGraph(tasks.map((task) => ({ ...task }))),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
}

test("C1 web relay: /api/dispatch/azure-job forwards the message and /api/dispatch/azure-job/validate relays the verdict", async (context) => {
  const hubDir = mkdtempSync(join(tmpdir(), "wf-web-dispatch-"));
  context.after(() => rmSync(hubDir, { recursive: true, force: true }));

  const dispatched: unknown[] = [];
  const validated: string[] = [];
  const hubApplication = new WorkflowApplication(
    new TaskGraph(tasks.map((task) => ({ ...task }))),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  const hub = await createWorkflowHub(hubApplication, {
    discoveryDir: hubDir,
    graph: new TaskGraph(tasks.map((task) => ({ ...task }))),
    dispatchAzureJob: async (message) => {
      dispatched.push(message);
      return { taskId: "task-123", messageId: "mid-1", viaBlobRef: false };
    },
    validateDispatch: async (id) => {
      validated.push(id);
      return { taskId: id, status: "covered", exitCode: 0, branch: `workflow/${id}`, prUrl: "https://example.test/pr/1" };
    },
  });
  context.after(() => hub.close());

  const server = createWorkflowWebServer(applicationFixture(), undefined, undefined, { hubDiscoveryDir: hubDir });
  const port = await listen(server);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${port}`;

  // The hub route is operator-token class: a direct call without the token is
  // 401 — the browser never holds that credential, only the proxy does.
  const directDenied = await fetch(`${hub.url}/dispatch/azure-job`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(directDenied.status, 401);

  // Forward the full task-spec message VERBATIM through the relay.
  const message = { specVersion: 1, taskId: "task-123", repo: { url: "u", ref: "r" } };
  const queued = await fetch(`${base}/api/dispatch/azure-job`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(message),
  });
  assert.equal(queued.status, 200);
  assert.deepEqual(await queued.json(), {
    dispatch: { state: "queued", taskId: "task-123", messageId: "mid-1", viaBlobRef: false },
  });
  assert.deepEqual(dispatched, [message], "the relay must forward the message verbatim, never reshape it");

  // Validate forwards only the string taskId and relays the hub's verdict.
  const verdict = await fetch(`${base}/api/dispatch/azure-job/validate`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ taskId: "task-123", injected: true }),
  });
  assert.equal(verdict.status, 200);
  assert.deepEqual(await verdict.json(), {
    validation: { taskId: "task-123", status: "covered", exitCode: 0, branch: "workflow/task-123", prUrl: "https://example.test/pr/1" },
  });
  assert.deepEqual(validated, ["task-123"], "only the taskId is forwarded upstream");

  // Proxy-side shape guards: a non-object dispatch body and a missing taskId
  // are 400s before any queue write.
  const badDispatch = await fetch(`${base}/api/dispatch/azure-job`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify([1, 2, 3]),
  });
  assert.equal(badDispatch.status, 400);
  const badValidate = await fetch(`${base}/api/dispatch/azure-job/validate`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ taskId: 7 }),
  });
  assert.equal(badValidate.status, 400);

  // Shared mutation guards: cross-origin is 403, a non-JSON content-type 415.
  const crossOrigin = await fetch(`${base}/api/dispatch/azure-job`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify(message),
  });
  assert.equal(crossOrigin.status, 403);
  const wrongType = await fetch(`${base}/api/dispatch/azure-job`, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: base },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
});

test("C1 web relay: a hub composed without the dispatch capability answers 404 (withheld) through the relay", async (context) => {
  const hubDir = mkdtempSync(join(tmpdir(), "wf-web-dispatch-none-"));
  context.after(() => rmSync(hubDir, { recursive: true, force: true }));
  const hub = await createWorkflowHub(applicationFixture(), {
    discoveryDir: hubDir,
    graph: new TaskGraph(tasks.map((task) => ({ ...task }))),
  });
  context.after(() => hub.close());

  const server = createWorkflowWebServer(applicationFixture(), undefined, undefined, { hubDiscoveryDir: hubDir });
  const port = await listen(server);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/dispatch/azure-job`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ specVersion: 1, taskId: "t" }),
  });
  assert.equal(response.status, 404, "a withheld capability is 404, not a fabricated queue");
});

test("C1 web relay: a missing hub answers 503, never a fabricated success", async (context) => {
  const orphanDir = mkdtempSync(join(tmpdir(), "wf-web-dispatch-orphan-"));
  context.after(() => rmSync(orphanDir, { recursive: true, force: true }));
  const server = createWorkflowWebServer(applicationFixture(), undefined, undefined, { hubDiscoveryDir: orphanDir });
  const port = await listen(server);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/dispatch/azure-job`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ specVersion: 1, taskId: "t" }),
  });
  assert.equal(response.status, 503);
});
