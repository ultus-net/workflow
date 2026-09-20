import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { createScheduleRegistry } from "../src/integrations/schedule-registry.js";
import { createSelfImprovementRegistry } from "../src/integrations/self-improvement-registry.js";
import { createWorkflowWebServer } from "../src/ui/web.js";

/**
 * W074/W073 operator surfaces through the web service: the browser reaches the
 * hub's schedule table and loop registry via /api proxies only. The hub is the
 * single writer; the verifier-gated actions (loop start, schedule run-now) are
 * deliberately NOT proxied — the browser must never hold that credential.
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

async function listen(server: ReturnType<typeof createWorkflowWebServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

test("the web service proxies the hub schedule table and loop registry", async (context) => {
  const hubDir = mkdtempSync(join(tmpdir(), "wf-web-hub-"));
  const ws = mkdtempSync(join(tmpdir(), "wf-web-hub-ws-"));
  context.after(() => rmSync(hubDir, { recursive: true, force: true }));
  context.after(() => rmSync(ws, { recursive: true, force: true }));

  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
    ws,
  );
  const gate = deferred<void>();
  const loopRegistry = createSelfImprovementRegistry({
    runLoop: async () => {
      await gate.promise;
      return { status: "stopped", reason: "cancelled by operator", iterations: [], accepted: 0, rejected: 0, committed: [], best: undefined };
    },
  });
  const scheduleRegistry = createScheduleRegistry({ path: join(hubDir, "scheduler.json") });
  scheduleRegistry.save({ id: "nightly", title: "Nightly audit", cron: "0 9 * * *", prompt: "audit", workspace: ws });
  const hub = await createWorkflowHub(application, {
    discoveryDir: hubDir,
    graph,
    schedules: scheduleRegistry,
    selfImprovement: loopRegistry,
  });
  context.after(() => hub.close());

  const webApplication = new WorkflowApplication(
    new TaskGraph(tasks.map((task) => ({ ...task }))),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: hubDir });
  const port = await listen(server);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${port}`;

  // Schedules list with a server-computed next-run preview.
  const listed = await fetch(`${base}/api/schedules`).then((r) => r.json() as Promise<{ schedules: Array<{ id: string; cron: string; nextRunAt: string | null }> }>);
  assert.equal(listed.schedules.length, 1);
  assert.equal(listed.schedules[0]?.id, "nightly");
  assert.match(listed.schedules[0]?.nextRunAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  // Pause via save (operator path); the hub table is the writer.
  const saved = await fetch(`${base}/api/schedules/save`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    // The browser payload carries the server-computed nextRunAt and an
    // arbitrary extra key; the proxy strips to the schedule schema so neither
    // is ever persisted by the hub.
    body: JSON.stringify({ id: "nightly", title: "Nightly audit", cron: "0 9 * * *", prompt: "audit", workspace: ws, enabled: false, nextRunAt: "2030-01-01T00:00:00.000Z", injected: true }),
  });
  assert.equal(saved.status, 200);
  const paused = await fetch(`${base}/api/schedules`).then((r) => r.json() as Promise<{ schedules: Array<{ enabled?: boolean; nextRunAt?: unknown; injected?: unknown }> }>);
  assert.equal(paused.schedules[0]?.enabled, false);
  assert.notEqual(paused.schedules[0]?.nextRunAt, "2030-01-01T00:00:00.000Z", "nextRunAt is recomputed, never persisted from the client");
  assert.equal(paused.schedules[0]?.injected, undefined, "unknown client keys are stripped before the hub persists them");

  // Guards mirror the other mutation endpoints.
  const crossOrigin = await fetch(`${base}/api/schedules/delete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ id: "nightly" }),
  });
  assert.equal(crossOrigin.status, 403);

  // Loops: start one through the hub (verifier credential), see it in
  // /api/loops, and cancel it from the UI path.
  const verifierPath = resolveHubDiscoveryPath(hubDir).replace("discovery.json", "verifier.json");
  const { token: verifierToken } = JSON.parse(readFileSync(verifierPath, "utf8")) as { token: string };
  const started = await fetch(`${hub.url}/rsi/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${verifierToken}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace: ws, objective: "reduce flaky tests", maxIterations: 2 }),
  });
  assert.equal(started.status, 200);
  const loopId = ((await started.json()) as { loop: { id: string } }).loop.id;

  const loops = await fetch(`${base}/api/loops`).then((r) => r.json() as Promise<{ loops: Array<{ id: string; state: string }> }>);
  assert.equal(loops.loops[0]?.id, loopId);
  assert.equal(loops.loops[0]?.state, "running");

  const cancelled = await fetch(`${base}/api/loops/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ id: loopId }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as { cancelled: boolean }).cancelled, true);

  // A missing hub means 503, never a fabricated list.
  const orphanServer = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: mkdtempSync(join(tmpdir(), "wf-web-orphan-")) });
  const orphanPort = await listen(orphanServer);
  context.after(() => new Promise<void>((resolve) => orphanServer.close(() => resolve())));
  const orphan = await fetch(`http://127.0.0.1:${orphanPort}/api/schedules`);
  assert.equal(orphan.status, 503);
});
