import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { createSelfImprovementRegistry } from "../src/integrations/self-improvement-registry.js";
import type { LoopOutcome } from "../src/integrations/self-improvement-loop.js";

/**
 * W073 trigger surface: the hub exposes operator-token `/rsi/start|status|cancel`
 * routes. Agents never reach these routes; the verifier token is rejected.
 */

const tasks: WorkflowTask[] = [
  { id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function outcome(status: LoopOutcome["status"], reason: string): LoopOutcome {
  return { status, reason, iterations: [], accepted: 0, rejected: 0, committed: [], best: undefined };
}

async function post(url: string, token: string, path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function setupHub(t: { after: (fn: () => void) => void }, withRegistry: boolean) {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const workspace = mkdtempSync(join(tmpdir(), "wf-hub-rsi-ws-"));
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-rsi-"));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    workspace,
  );
  const gate = deferred<LoopOutcome>();
  const registry = createSelfImprovementRegistry({ runLoop: () => gate.promise });
  const hub = await createWorkflowHub(application, {
    discoveryDir: dir,
    graph,
    ...(withRegistry ? { selfImprovement: registry } : {}),
  });
  t.after(() => hub.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8")) as { token: string };
  return { hub, token, registry, gate, workspace, verificationToken: hub.verificationToken };
}

const SPEC = { objective: "reduce flaky tests", maxIterations: 3 };

test("the verifier credential starts, the operator token monitors and cancels", async (t) => {
  const { hub, token, verificationToken, gate, workspace } = await setupHub(t, true);

  const started = await post(hub.url, verificationToken, "/rsi/start", { workspace, ...SPEC });
  assert.equal(started.status, 200, "starting a loop requires the verifier credential");
  const loop = started.body.loop as { id: string; state: string };
  assert.equal(loop.state, "running");

  // P0-2: the review gate is on by default — an unspecified flag must never
  // produce an evidence-free acceptance path.
  assert.equal((started.body.loop as { spec: { requiresReview: boolean } }).spec.requiresReview, true);

  const status = await post(hub.url, token, "/rsi/status", {});
  assert.equal(status.status, 200);
  const loops = status.body.loops as Array<{ id: string; state: string }>;
  assert.equal(loops.length, 1);
  assert.equal(loops[0]?.state, "running");

  const single = await post(hub.url, token, "/rsi/status", { id: loop.id });
  assert.equal((single.body.loop as { id: string }).id, loop.id);

  const cancelled = await post(hub.url, token, "/rsi/cancel", { id: loop.id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancelled, true);

  gate.resolve(outcome("stopped", "cancelled by operator"));
  await new Promise((resolve) => setImmediate(resolve));
  const after = await post(hub.url, token, "/rsi/status", { id: loop.id });
  assert.equal((after.body.loop as { state: string }).state, "cancelled");
});

test("the ordinary operator token cannot start a loop; only the verifier credential can", async (t) => {
  const { hub, token, verificationToken, workspace } = await setupHub(t, true);
  // P1-1: the ordinary surface token (which any same-UID surface holds) must
  // not be able to switch on an autonomous mutation loop.
  assert.equal((await post(hub.url, token, "/rsi/start", { workspace, ...SPEC })).status, 401);
  const started = await post(hub.url, verificationToken, "/rsi/start", { workspace, ...SPEC });
  assert.equal(started.status, 200);
});

test("explicit requiresReview:false is the only way to drop the review gate", async (t) => {
  const { hub, verificationToken, gate, workspace } = await setupHub(t, true);
  const response = await post(hub.url, verificationToken, "/rsi/start", {
    workspace,
    ...SPEC,
    requiresReview: false,
  });
  assert.equal(response.status, 200);
  assert.equal((response.body.loop as { spec: { requiresReview: boolean } }).spec.requiresReview, false);
  gate.resolve(outcome("stopped", "cancelled by operator"));
});

test("invalid start requests and duplicate running loops are rejected as client errors", async (t) => {
  const { hub, verificationToken, workspace } = await setupHub(t, true);
  assert.equal((await post(hub.url, verificationToken, "/rsi/start", { workspace })).status, 400, "missing objective/limits");

  const first = await post(hub.url, verificationToken, "/rsi/start", { workspace, ...SPEC });
  assert.equal(first.status, 200);
  const duplicate = await post(hub.url, verificationToken, "/rsi/start", { workspace, ...SPEC });
  assert.equal(duplicate.status, 400, "a second loop for the same workspace is refused, not queued");
  assert.match(String(duplicate.body.error), /already running/);
});

test("the rsi routes 404 when no self-improvement registry is configured", async (t) => {
  const { hub, token, verificationToken } = await setupHub(t, false);
  assert.equal((await post(hub.url, verificationToken, "/rsi/start", { workspace: process.cwd(), ...SPEC })).status, 404);
  assert.equal((await post(hub.url, token, "/rsi/status", {})).status, 404);
  assert.equal((await post(hub.url, token, "/rsi/cancel", {})).status, 404);
});