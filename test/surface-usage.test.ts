import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { surfaceStamp, surfaceUsageSink, type SurfaceUsageSummary } from "../src/integrations/task-usage.js";
import { createSurfaceUsagePost, createSurfaceUsageSessionPost } from "../src/integrations/surface-usage-client.js";
import type { ModelUsageMetrics } from "../src/integrations/model-usage-proxy.js";

/**
 * P4 topology Option A1 (issue #283): the provenance-stamped cross-process
 * record path. A process-separated interactive surface posts its boundary
 * delta to the observability-only `POST /usage/record` route; the hub records
 * it as a PROVENANCE-STAMPED surface OBSERVATION — never as hub-authoritative
 * task attribution (the W153 principle). These pins are the route + stamp +
 * canonical-isolation boundary; the surface compositions are pinned by the
 * focused source wiring and recorded in `docs/ledger/topo-a1.md`.
 */

const metrics = (overrides: Partial<ModelUsageMetrics> = {}): ModelUsageMetrics => ({
  requests: 0,
  usageEvents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  latestPromptTokens: undefined,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...overrides,
});

function setup() {
  const graph = new TaskGraph([{ id: taskId("W1"), title: "interactive", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [] } satisfies WorkflowTask]);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
  );
  return { graph, application, registry: createRunRegistry(application, graph) };
}

function post(body: unknown, bridge: { url: string; token: string }) {
  return fetch(`${bridge.url}/usage/record`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validObservation = {
  recordedBy: "surface:web-service",
  taskId: "W1",
  requests: 2,
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  costUsd: 0.01,
  cacheReadTokens: 40,
  cacheCreateTokens: 5,
};

/** P4 A2: the counters-only record wire shape (no taskId, no recordedBy). */
const counters = {
  requests: 2,
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  costUsd: 0.01,
  cacheReadTokens: 40,
  cacheCreateTokens: 5,
};

/** P4 A2: the hub mints a single-use session id bound to the declared task. */
function mint(taskId: string, bridge: { url: string; token: string }) {
  return fetch(`${bridge.url}/usage/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
}

async function mintId(taskId: string, bridge: { url: string; token: string }): Promise<string> {
  const response = await mint(taskId, bridge);
  assert.equal(response.status, 200, "the hub mints a session id");
  return ((await response.json()) as { sessionId: string }).sessionId;
}

test("P4 A1: a posted delta is recorded as a provenance-stamped surface observation (red-first: the route/report did not exist)", async () => {
  const base = setup();
  const bridge = await createWorkflowHubBridge(
    base.application,
    base.registry.resolve,
    base.registry.controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { recordSurfaceUsage: base.registry.recordSurfaceUsage },
  );
  try {
    const answer = await post(validObservation, bridge);
    assert.equal(answer.status, 200);
    const journal = base.registry.surfaceUsage();
    assert.equal(journal.length, 1, "exactly one surface observation is recorded");
    assert.equal(journal[0]?.recordedBy, "surface:web-service", "the provenance stamp is recorded verbatim");
    assert.equal(journal[0]?.taskId, "W1");
    assert.equal(journal[0]?.totalTokens, 120);
    assert.ok(typeof journal[0]?.recordedAt === "string", "the hub stamps recordedAt at journal time");
  } finally {
    await bridge.close();
  }
});

test("P4 A1: a spoofed/unstamped task id is NOT trusted as authoritative — it lands in the surface journal, never the canonical taskUsage", async () => {
  const base = setup();
  const bridge = await createWorkflowHubBridge(
    base.application,
    base.registry.resolve,
    base.registry.controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { recordSurfaceUsage: base.registry.recordSurfaceUsage },
  );
  try {
    const answer = await post({ ...validObservation, taskId: "spoofed:canonical-attribution" }, bridge);
    assert.equal(answer.status, 200);
    assert.equal(base.registry.taskUsage().length, 0, "the canonical task attribution journal is untouched");
    assert.equal(base.registry.surfaceUsage().length, 1, "the observation is recorded under the labelled surface journal");
    assert.equal(base.registry.surfaceUsage()[0]?.recordedBy, "surface:web-service");
  } finally {
    await bridge.close();
  }
});

test("P4 A1: the route requires a non-empty 'surface:' provenance stamp and a well-formed delta", async () => {
  const base = setup();
  const bridge = await createWorkflowHubBridge(
    base.application,
    base.registry.resolve,
    base.registry.controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { recordSurfaceUsage: base.registry.recordSurfaceUsage },
  );
  try {
    // Missing stamp.
    assert.equal((await post({ ...validObservation, recordedBy: undefined }, bridge)).status, 400);
    // A foreign authority class cannot be claimed.
    assert.equal((await post({ ...validObservation, recordedBy: "hub" }, bridge)).status, 400);
    assert.equal((await post({ ...validObservation, recordedBy: "surface:" }, bridge)).status, 400);
    // Malformed numeric field.
    assert.equal((await post({ ...validObservation, totalTokens: "120" }, bridge)).status, 400);
    assert.equal((await post({ ...validObservation, costUsd: -1 }, bridge)).status, 400);
    // Empty task id.
    assert.equal((await post({ ...validObservation, taskId: "" }, bridge)).status, 400);
    assert.equal(base.registry.surfaceUsage().length, 0, "no malformed body is ever recorded");
  } finally {
    await bridge.close();
  }
});

test("P4 A1: the route is 404 when the hub holds no surface-observation capability (withheld, never faked)", async () => {
  const base = setup();
  const bridge = await createWorkflowHubBridge(base.application, base.registry.resolve, base.registry.controller);
  try {
    assert.equal((await post(validObservation, bridge)).status, 404);
  } finally {
    await bridge.close();
  }
});

test("P4 A1: /snapshot projects the surface journal with its provenance stamp, beside the canonical taskUsage", async () => {
  const base = setup();
  base.registry.recordTaskUsage({ taskId: "W1", requests: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.001, cacheReadTokens: 0, cacheCreateTokens: 0 });
  const bridge = await createWorkflowHubBridge(
    base.application,
    base.registry.resolve,
    base.registry.controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { recordSurfaceUsage: base.registry.recordSurfaceUsage },
  );
  try {
    assert.equal((await post(validObservation, bridge)).status, 200);
    const snapshot = await fetch(`${bridge.url}/snapshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(snapshot.status, 200);
    const payload = (await snapshot.json()) as { gateObservability?: { surfaceUsage?: SurfaceUsageSummary[]; taskUsage?: unknown[] } };
    const rows = payload.gateObservability?.surfaceUsage ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.recordedBy, "surface:web-service");
    assert.equal(payload.gateObservability?.taskUsage?.length, 1, "the canonical journal is a separate, still-present lane");
  } finally {
    await bridge.close();
  }
});

test("P4 A1: the surface sink stamps recordedBy and publishes only a completed turn", () => {
  const recorded: Array<{ recordedBy: string; totalTokens: number }> = [];
  let current = metrics({ totalTokens: 100 });
  const sink = surfaceUsageSink(() => current, "surface:acp-tui", (observation) => recorded.push({ recordedBy: observation.recordedBy, totalTokens: observation.totalTokens }));
  assert.equal(sink.usage(), current, "the reading is the surface's own metrics");
  // A completed turn publishes one stamped observation.
  current = metrics({ totalTokens: 160 });
  sink.record({ taskId: "W1", requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 60, costUsd: 0.006, cacheReadTokens: 0, cacheCreateTokens: 0 });
  assert.deepEqual(recorded, [{ recordedBy: "surface:acp-tui", totalTokens: 60 }]);
});

test("P4 A1 (per-session granularity): the stamp carries a STABLE session id when one exists, and names the surface alone otherwise", async () => {
  assert.equal(surfaceStamp("acp-tui"), "surface:acp-tui", "no stable session id at a per-process composition point → the surface alone");
  assert.equal(surfaceStamp("web-service", "web-abc"), "surface:web-service:web-abc", "a stable session id is stamped after the surface, keeping the mandatory prefix");
  const base = setup();
  const bridge = await createWorkflowHubBridge(
    base.application,
    base.registry.resolve,
    base.registry.controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { recordSurfaceUsage: base.registry.recordSurfaceUsage },
  );
  try {
    assert.equal((await post({ ...validObservation, recordedBy: "surface:web-service:web-abc" }, bridge)).status, 200);
    assert.equal(base.registry.surfaceUsage()[0]?.recordedBy, "surface:web-service:web-abc", "the per-session stamp is recorded verbatim");
    assert.equal(base.registry.taskUsage().length, 0, "a per-session stamp is still a labelled observation, never canonical attribution");
  } finally {
    await bridge.close();
  }
});

test("P4 A1: the cross-process post fails closed with no hub — nothing recorded, and it never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-surface-usage-"));
  try {
    let called = 0;
    const post = createSurfaceUsagePost({
      hubDiscoveryDir: dir,
      fetchImpl: (async () => { called += 1; return new Response("{}"); }) as typeof fetch,
    });
    post({ recordedBy: "surface:test", taskId: "W1", requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, 0, "no hub discovery file → no post is attempted (never a fabricated record)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4 A1: the cross-process post relays the stamped observation to the discovered hub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-surface-usage-"));
  const calls: Array<{ url: string; body: string | undefined; authorization: string | undefined }> = [];
  try {
    mkdirSync(join(dir, "hub"), { recursive: true });
    writeFileSync(join(dir, "hub", "discovery.json"), JSON.stringify({ endpoint: "http://127.0.0.1:9", token: "t0ken" }));
    const post = createSurfaceUsagePost({
      hubDiscoveryDir: dir,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined, authorization: (init?.headers as Record<string, string>)?.authorization });
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    post({ recordedBy: "surface:driver-registry", taskId: "W1", requests: 1, promptTokens: 2, completionTokens: 3, totalTokens: 5, costUsd: 0.1, cacheReadTokens: 0, cacheCreateTokens: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, "a discovered hub receives the observation");
    assert.equal(calls[0]?.url, "http://127.0.0.1:9/usage/record");
    assert.equal(calls[0]?.authorization, "Bearer t0ken");
    assert.match(calls[0]?.body ?? "", /surface:driver-registry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * P4 topology Option A2 (issue #283): the hub-bound session path. The hub mints
 * a single-use session id bound to a task from its OWN registration record; the
 * surface posts only counters + that id, and the hub resolves session→task and
 * writes the CANONICAL `taskUsage` journal. A1's labelled-observation path
 * stays as the fallback for a body with no session id.
 */

async function bridgeWithSessions(base: ReturnType<typeof setup>) {
  return createWorkflowHubBridge(
    base.application,
    base.registry.resolve,
    base.registry.controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      recordSurfaceUsage: base.registry.recordSurfaceUsage,
      registerSurfaceSession: base.registry.registerSurfaceSession,
      consumeSurfaceSession: base.registry.consumeSurfaceSession,
    },
  );
}

test("P4 A2: a hub-minted single-use session id resolves to the registered task and writes canonical taskUsage (red-first: the mint route did not exist)", async () => {
  const base = setup();
  const bridge = await bridgeWithSessions(base);
  try {
    const sessionId = await mintId("W1", bridge);
    assert.match(sessionId, /^[0-9a-f]{32}$/, "the id is a hub-minted opaque nonce, never client-chosen");
    assert.equal((await post({ sessionId, ...counters }, bridge)).status, 200);
    const canonical = base.registry.taskUsage();
    assert.equal(canonical.length, 1, "exactly one CANONICAL task record is written");
    assert.equal(canonical[0]?.taskId, "W1", "the hub resolves the registered task from its own record");
    assert.equal(canonical[0]?.totalTokens, 120);
    assert.equal(base.registry.surfaceUsage().length, 0, "A2 writes the canonical journal, NOT the separate surface journal");
  } finally {
    await bridge.close();
  }
});

test("P4 A2: an unknown/spoofed session id is rejected fail-closed and never reaches canonical attribution", async () => {
  const base = setup();
  const bridge = await bridgeWithSessions(base);
  try {
    // Never minted by this hub (a spoofed nonce).
    const answer = await post({ sessionId: "deadbeefdeadbeefdeadbeefdeadbeef", ...counters }, bridge);
    assert.equal(answer.status, 400);
    assert.equal(base.registry.taskUsage().length, 0, "a spoofed id never reaches canonical attribution");
    assert.equal(base.registry.surfaceUsage().length, 0, "and never a labelled observation either");
    // A nonce-shaped-but-empty id is equally rejected.
    assert.equal((await post({ sessionId: "", ...counters }, bridge)).status, 400);
  } finally {
    await bridge.close();
  }
});

test("P4 A2: single-use is enforced — a consumed session id is rejected on replay", async () => {
  const base = setup();
  const bridge = await bridgeWithSessions(base);
  try {
    const sessionId = await mintId("W1", bridge);
    assert.equal((await post({ sessionId, ...counters }, bridge)).status, 200);
    // Replay of the SAME minted id is refused: single-use nonce discipline.
    assert.equal((await post({ sessionId, ...counters }, bridge)).status, 400);
    assert.equal(base.registry.taskUsage().length, 1, "the replay never double-writes canonical attribution");
  } finally {
    await bridge.close();
  }
});

test("P4 A2: the A2 record wire carries no client attribution — a taskId beside a session id is rejected", async () => {
  const base = setup();
  const bridge = await bridgeWithSessions(base);
  try {
    const sessionId = await mintId("W1", bridge);
    const answer = await post({ sessionId, taskId: "spoofed:canonical", ...counters }, bridge);
    assert.equal(answer.status, 400, "the A2 schema has no taskId; the client cannot present attribution");
    assert.equal(base.registry.taskUsage().length, 0);
  } finally {
    await bridge.close();
  }
});

test("P4 A2: distinct sessions bind distinct tasks and never interleave or fold", async () => {
  const base = setup();
  const bridge = await bridgeWithSessions(base);
  try {
    const first = await mintId("W1", bridge);
    const second = await mintId("W2", bridge);
    assert.notEqual(first, second, "each mint is a distinct nonce");
    assert.equal((await post({ sessionId: first, ...counters }, bridge)).status, 200);
    assert.equal((await post({ sessionId: second, ...counters, totalTokens: 7, requests: 1, promptTokens: 7, completionTokens: 0, costUsd: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, bridge)).status, 200);
    const canonical = base.registry.taskUsage();
    assert.equal(canonical.length, 2);
    assert.deepEqual(canonical.map((entry) => entry.taskId).sort(), ["W1", "W2"]);
    assert.equal(canonical.find((entry) => entry.taskId === "W1")?.totalTokens, 120);
    assert.equal(canonical.find((entry) => entry.taskId === "W2")?.totalTokens, 7);
  } finally {
    await bridge.close();
  }
});

test("P4 A2: the session client mints a hub id then relays only counters + session id (taskId never on the record wire)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-surface-session-"));
  const calls: Array<{ url: string; body: string | undefined }> = [];
  try {
    mkdirSync(join(dir, "hub"), { recursive: true });
    writeFileSync(join(dir, "hub", "discovery.json"), JSON.stringify({ endpoint: "http://127.0.0.1:9", token: "t0ken" }));
    const post = createSurfaceUsageSessionPost({
      hubDiscoveryDir: dir,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
        if (url.endsWith("/usage/session")) return new Response(JSON.stringify({ sessionId: "abc123" }), { status: 200 });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    post({ taskId: "W1", requests: 1, promptTokens: 2, completionTokens: 3, totalTokens: 5, costUsd: 0.1, cacheReadTokens: 0, cacheCreateTokens: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, "the client mints, then records");
    assert.equal(calls[0]?.url, "http://127.0.0.1:9/usage/session");
    assert.match(calls[0]?.body ?? "", /"taskId":"W1"/);
    assert.equal(calls[1]?.url, "http://127.0.0.1:9/usage/record");
    const recordBody = JSON.parse(calls[1]?.body ?? "{}") as Record<string, unknown>;
    assert.equal(recordBody.sessionId, "abc123");
    assert.equal(recordBody.totalTokens, 5);
    assert.equal(recordBody.taskId, undefined, "the taskId field is REMOVED from the record wire");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4 A2: the session client fails closed with no hub — nothing minted, nothing recorded, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-surface-session-"));
  try {
    let called = 0;
    const post = createSurfaceUsageSessionPost({
      hubDiscoveryDir: dir,
      fetchImpl: (async () => { called += 1; return new Response("{}"); }) as typeof fetch,
    });
    post({ taskId: "W1", requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, 0, "no hub discovery file → no mint is attempted (never a fabricated record)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
