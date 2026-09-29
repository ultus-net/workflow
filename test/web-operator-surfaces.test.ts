import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { evidenceId, observationId, taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { createEvidenceContentStore } from "../src/integrations/evidence-content-store.js";
import { createWorkflowHub, resolveHubDiscoveryPath, type WorkflowHubSchedulerHandles } from "../src/integrations/workflow-hub.js";
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

  // W085 review P2: the strip must also FORWARD the advanced schedule fields
  // (budget/taskClass/off-peak) — the browser edit path spreads the full
  // existing entry under the form fields precisely so these survive; a strip
  // regression would silently drop them on every edit.
  const withAdvanced = await fetch(`${base}/api/schedules/save`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ id: "nightly", title: "Nightly audit", cron: "0 9 * * *", prompt: "audit", workspace: ws, budget: { maxTotalTokens: 50_000 }, taskClass: "general", offPeak: "deepseek", injected2: true }),
  });
  assert.equal(withAdvanced.status, 200);
  const advanced = await fetch(`${base}/api/schedules`).then((r) => r.json() as Promise<{ schedules: Array<{ budget?: unknown; taskClass?: string; offPeak?: string; injected2?: unknown }> }>);
  assert.deepEqual(advanced.schedules[0]?.budget, { maxTotalTokens: 50_000 }, "budget survives the browser edit round-trip");
  assert.equal(advanced.schedules[0]?.taskClass, "general", "taskClass survives the browser edit round-trip");
  assert.equal(advanced.schedules[0]?.offPeak, "deepseek", "offPeak survives the browser edit round-trip");
  assert.equal(advanced.schedules[0]?.injected2, undefined, "unknown keys stay stripped");

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

test("W158: the web relays the hub's evidence block and serves content previews; the browser never sees a hub token", async (context) => {
  const hubDir = mkdtempSync(join(tmpdir(), "wf-web-evidence-"));
  const ws = mkdtempSync(join(tmpdir(), "wf-web-evidence-ws-"));
  context.after(() => rmSync(hubDir, { recursive: true, force: true }));
  context.after(() => rmSync(ws, { recursive: true, force: true }));

  const tasks: WorkflowTask[] = [
    { id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
  ];
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
    ws,
  );
  // The test owns the hub's content store so it can put a capture and hold
  // the ref — the same composition the hub CLI wires (an always-present
  // store → the route exists and captures ride).
  const contentStore = createEvidenceContentStore();
  const stored = contentStore.put("test-output", "text/plain", "163/163 pass");
  assert.ok(stored !== undefined, "an under-cap capture stores");
  const hub = await createWorkflowHub(application, { discoveryDir: hubDir, graph, contentStore });
  context.after(() => hub.close());

  // The capture rides the very evidence record (the run-registry capture
  // shape): recorded into the hub's base application at the current epoch.
  application.recordEvidence({
    id: evidenceId("test-evidence:relay-preview"),
    observationId: observationId("test-observation:relay-preview"),
    authority: "environment",
    subject: "test evidence for run:relay-preview",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
    content: { kind: "test-output", ref: stored.ref, byteSize: stored.byteSize },
  });

  const webApplication = new WorkflowApplication(
    new TaskGraph(tasks.map((task) => ({ ...task }))),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: hubDir });
  const port = await listen(server);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${port}`;

  // The evidence relay: the hub record rides with its content reference.
  const relayed = await fetch(`${base}/api/evidence`).then((r) => r.json() as Promise<{ evidence: Array<{ subject: string; content?: { kind: string; ref: string; byteSize: number } }> | null; reason?: string }>);
  assert.ok(Array.isArray(relayed.evidence), "the relay answers the hub's evidence block");
  const row = relayed.evidence?.find((entry) => entry.subject === "test evidence for run:relay-preview");
  assert.ok(row !== undefined, "the capture-carrying record is relayed");
  assert.deepEqual(row.content, { kind: "test-output", ref: stored.ref, byteSize: stored.byteSize }, "the content reference rides verbatim");

  // The hub token never rides the relay.
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(hubDir), "utf8")) as { token: string };
  const relayText = JSON.stringify(relayed);
  assert.ok(relayText.length > 0 && !relayText.includes(token), "the relay response never carries the hub token");

  // The same-origin preview proxy serves the bytes the store holds.
  const preview = await fetch(`${base}/api/evidence-content`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ ref: stored.ref }),
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { kind: "test-output", mediaType: "text/plain", bytes: "163/163 pass", byteSize: 12 }, "the capture rides verbatim");

  // An unknown/evicted ref passes the hub's honest 404 through, unrewritten.
  const missing = await fetch(`${base}/api/evidence-content`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ ref: "content:nope:404" }),
  });
  assert.equal(missing.status, 404);

  // A malformed body is a client fault at this route.
  const malformed = await fetch(`${base}/api/evidence-content`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({}),
  });
  assert.equal(malformed.status, 400);

  // The origin guard mirrors the other mutation proxies.
  const crossOrigin = await fetch(`${base}/api/evidence-content`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ ref: stored.ref }),
  });
  assert.equal(crossOrigin.status, 403);
  const wrongType = await fetch(`${base}/api/evidence-content`, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: base },
    body: JSON.stringify({ ref: stored.ref }),
  });
  assert.equal(wrongType.status, 415);

  // No hub: the relay degrades to a named absence and the proxy answers 503 —
  // never a fabricated list, never a token.
  const orphanServer = createWorkflowWebServer(
    new WorkflowApplication(new TaskGraph(tasks.map((task) => ({ ...task }))), hostCapabilities({ transport: "acp", authoritativePreMutation: false })),
    undefined,
    undefined,
    { hubDiscoveryDir: mkdtempSync(join(tmpdir(), "wf-web-evidence-orphan-")) },
  );
  const orphanPort = await listen(orphanServer);
  context.after(() => new Promise<void>((resolve) => orphanServer.close(() => resolve())));
  const orphanBase = `http://127.0.0.1:${orphanPort}`;
  const noHubRelay = await fetch(`${orphanBase}/api/evidence`).then((r) => r.json() as Promise<{ evidence: unknown; reason?: string }>);
  assert.equal(noHubRelay.evidence, null);
  assert.equal(noHubRelay.reason, "hub unavailable");
  const noHubPreview = await fetch(`${orphanBase}/api/evidence-content`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: orphanBase },
    body: JSON.stringify({ ref: stored.ref }),
  });
  assert.equal(noHubPreview.status, 503);
  const noHubBody = await noHubPreview.json() as { error?: string };
  assert.equal(noHubBody.error, "hub unavailable");
});

// W175: the runs relay — the hub's /snapshot runs block (the run-registry
// projection) served through the same guard pattern as the evidence relay:
// the hub token stays server-side, a hub without the block answers the named
// absence, and the registry's shape-honesty records ride verbatim.
test("W175: the web relays the hub's run-registry projection (/api/runs); the browser never sees a hub token", async (context) => {
  const hubDir = mkdtempSync(join(tmpdir(), "wf-web-runs-"));
  const ws = mkdtempSync(join(tmpdir(), "wf-web-runs-ws-"));
  context.after(() => rmSync(hubDir, { recursive: true, force: true }));
  context.after(() => rmSync(ws, { recursive: true, force: true }));

  const tasks: WorkflowTask[] = [
    { id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] },
  ];
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
    ws,
  );
  // The test captures the run-registry handles the way the composition
  // root's scheduler does: the begin stamp, the usage totals, the claims,
  // and the blocking reason are hub-side records the browser never supplies.
  const captured: WorkflowHubSchedulerHandles[] = [];
  const hub = await createWorkflowHub(application, {
    discoveryDir: hubDir,
    graph,
    schedulerFactory: (handles) => {
      captured.push(handles);
      return { tick: async () => undefined, trigger: async () => false, start: () => undefined, stop: () => undefined };
    },
  });
  context.after(() => hub.close());
  const handles = captured[0];
  assert.ok(handles !== undefined, "the hub composes the run registry when a graph is wired");

  const runId = "schedule:nightly:relay";
  await handles.controller.begin({
    runId,
    title: "Nightly audit",
    workspace: ws,
    origin: { kind: "schedule", scheduleId: "nightly" },
  });
  handles.recordRunUsage({
    runId,
    usage: { requests: 3, promptTokens: 1200, completionTokens: 80, totalTokens: 1280, costUsd: 0.0042, cacheReadTokens: 600, cacheCreateTokens: 40 },
  });
  handles.recordCompletionClaim({ runId, claim: "audit complete" });
  handles.recordReasoningClaim({ runId, sentence: "claimed the audit verified with no observed action" });
  handles.noteReasoningClaimMonitor({ runId });
  handles.recordBlockingReason({ runId, reason: "reviewer not yet run" });
  handles.controller.recordWorkProductLink?.({ runId, link: { provider: "github", key: "#346", url: "https://github.com/ultus-net/Workflow/pull/346" } });

  // A run row WITHOUT a registry begin record: the kernel task id is the
  // identity, so a synthetic run: task pins the "no recorded time" absence —
  // the row renders without a derived timestamp.
  application.addTask({ id: taskId("run:ghost"), title: "Ghost run (no begin record)", dependencies: [], requiredEvidence: [] });

  const webApplication = new WorkflowApplication(
    new TaskGraph(tasks.map((task) => ({ ...task }))),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(webApplication, undefined, undefined, { hubDiscoveryDir: hubDir });
  const port = await listen(server);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${port}`;

  const relayed = await fetch(`${base}/api/runs`).then((r) => r.json() as Promise<{
    runs: {
      rows: Array<{ runId: string; title: string; state: string; startedAt?: string }>;
      origins?: Record<string, { kind: string; scheduleId?: string }>;
      workProducts?: Record<string, { provider: string; key: string; url: string }>;
      blockingReasons?: Record<string, string>;
      completionClaims?: Record<string, { claim: string; verifiedAtClaim: boolean; observedAt: string }>;
      usage?: Record<string, { totalTokens: number; costUsd: number; cacheReadTokens: number; cacheCreateTokens: number }>;
      reasoningClaims?: Record<string, { sentence: string }>;
      reasoningClaimMetrics?: { monitoredRuns: number; flaggedRuns: number; findings: number; recall: string; timeToResponseMs: string };
    } | null;
    reason?: string;
  }>);
  const runs = relayed.runs;
  assert.ok(runs != null, "a live hub answers the run-registry projection, not a named absence");

  // Every run row, not schedule-lane only; startedAt only where the record
  // carries one (the timeline house rule).
  const begun = runs.rows.find((row) => row.runId === "schedule:nightly:relay");
  assert.ok(begun !== undefined, "the begun run's row is relayed");
  assert.equal(begun.title, "Nightly audit");
  assert.equal(begun.state, "IN_PROGRESS");
  assert.match(begun.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/, "the row carries the begin record's own observedAt");
  const ghost = runs.rows.find((row) => row.runId === "ghost");
  assert.ok(ghost !== undefined, "a kernel run: task without a begin record is still a row");
  assert.equal(ghost.startedAt, undefined, "no recorded time: the row carries no derived timestamp");
  assert.deepEqual(runs.origins?.["schedule:nightly:relay"], { kind: "schedule", scheduleId: "nightly" }, "the recorded origin rides verbatim");
  assert.deepEqual(
    runs.workProducts?.["schedule:nightly:relay"],
    { provider: "github", key: "#346", url: "https://github.com/ultus-net/Workflow/pull/346" },
    "the recorded work-product link rides verbatim",
  );
  assert.equal(runs.blockingReasons?.["schedule:nightly:relay"], "reviewer not yet run");
  const claim = runs.completionClaims?.["schedule:nightly:relay"];
  assert.equal(claim?.claim, "audit complete");
  assert.equal(claim?.verifiedAtClaim, false, "the verified-at-claim flag rides beside the claim (the W114 honesty line)");
  const usage = runs.usage?.["schedule:nightly:relay"];
  assert.equal(usage?.totalTokens, 1280);
  assert.equal(usage?.costUsd, 0.0042);
  // The cache components ride the recorded totals with their lane asymmetry
  // (the RunUsageSummary comment: 0 on the OpenAI chat-completions lane,
  // where cached reads sit inside promptTokens) — present, never absent, so
  // the view can render the asymmetry instead of guessing it.
  assert.equal(usage?.cacheReadTokens, 600);
  assert.equal(usage?.cacheCreateTokens, 40);
  assert.ok(runs.reasoningClaims?.["schedule:nightly:relay"] !== undefined, "the advisory reasoning-claim finding rides");
  assert.deepEqual(
    runs.reasoningClaimMetrics,
    { monitoredRuns: 1, flaggedRuns: 1, findings: 1, recall: "unmeasured", timeToResponseMs: "unmeasured" },
    "the monitor metrics carry the unmeasured axes literally",
  );

  // The hub token never rides the relay.
  const { token } = JSON.parse(readFileSync(resolveHubDiscoveryPath(hubDir), "utf8")) as { token: string };
  const relayText = JSON.stringify(relayed);
  assert.ok(relayText.length > 0 && !relayText.includes(token), "the relay response never carries the hub token");

  // No hub: the relay degrades to the named absence — never a fabricated list.
  const orphanServer = createWorkflowWebServer(
    new WorkflowApplication(new TaskGraph(tasks.map((task) => ({ ...task }))), hostCapabilities({ transport: "acp", authoritativePreMutation: false })),
    undefined,
    undefined,
    { hubDiscoveryDir: mkdtempSync(join(tmpdir(), "wf-web-runs-orphan-")) },
  );
  const orphanPort = await listen(orphanServer);
  context.after(() => new Promise<void>((resolve) => orphanServer.close(() => resolve())));
  const noHub = await fetch(`http://127.0.0.1:${orphanPort}/api/runs`).then((r) => r.json() as Promise<{ runs: unknown; reason?: string }>);
  assert.equal(noHub.runs, null);
  assert.equal(noHub.reason, "hub unavailable");
});
