import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createWorkflowHubBridge, type HubBridgeCapabilities } from "../src/integrations/hub-http.js";
import { CARE_ASSERTION_RULE, readCareProjection, type CareProjection } from "../src/integrations/care-facts.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";
import { createWorkflowWebServer } from "../src/ui/web.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W213 — the hub's care fact read route (decision-brief Decision 2, Option C
// + the curated-core-only read rule). Mirrors test/hub-assistant-note.test.ts
// (W212) and pins the wire contract:
//   - POST /care answers { care: <projection> } verbatim — the projection
//     keeps `facts` (the curated core) and `annotations` (inert) SEPARATE,
//     carries `realityOrientation` ("unset" when policy.yaml is absent), and
//     the static versioned `rule`.
//   - absent capability -> 404 { error: "not found" } (capability withheld,
//     fail closed, like the other optional registries).
//   - the verifier credential does NOT authorize the read (operator-token
//     class only).
//   - the hub is POST-only: a GET is 401 at the gate.

interface Bridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

const seat = (context: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-care-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const seedApplication = (): WorkflowApplication => {
  const task: WorkflowTask = {
    id: taskId("seed"),
    title: "seed",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  };
  return new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
};

async function compose(context: TestContext, capabilities: HubBridgeCapabilities): Promise<Bridge> {
  const bridge = await createWorkflowHubBridge(
    seedApplication(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    capabilities,
  );
  context.after(() => bridge.close());
  return bridge;
}

const call = async (bridge: Bridge, path: string, token: string, body: unknown = {}): Promise<{ status: number; payload: unknown }> => {
  const response = await fetch(`${bridge.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
};

const PROJECTION: CareProjection = {
  root: "/workspace/care",
  facts: [{ key: "resident-name", value: "Margaret Ellis", category: "person" }],
  annotations: [{ key: "teacup-count", value: "3", observedAt: "2026-10-17T10:00:00.000Z", source: "care-turn" }],
  realityOrientation: "unset",
  rule: CARE_ASSERTION_RULE,
};

test("W213: a composed capability answers POST /care with the projection verbatim", async (context) => {
  void seat(context); // keep one temp seat per test for symmetry with siblings
  const bridge = await compose(context, { assistantCare: () => PROJECTION });
  const answered = await call(bridge, "/care", bridge.token);
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.payload, { care: PROJECTION }, "the hub relays the composed projection verbatim — it fabricates nothing");
});

test("W213: the real projection over a care dir keeps facts and annotations SEPARATE and reports the unset seam", async (context) => {
  const dir = seat(context);
  writeFileSync(join(dir, "core.yaml"), ["facts:", "  - key: resident-name", "    value: Margaret Ellis", "    category: person", ""].join("\n"));
  writeFileSync(join(dir, "annotations.json"), JSON.stringify({
    annotations: [{ key: "resident-name", value: "Margaret Smith", observedAt: "2026-10-17T10:00:00.000Z", source: "care-turn" }],
  }));
  // No policy.yaml: the Q28 seam reports "unset" honestly.
  const bridge = await compose(context, { assistantCare: () => readCareProjection(dir) });
  const answered = await call(bridge, "/care", bridge.token);
  assert.equal(answered.status, 200);
  const care = (answered.payload as { care: {
    root: string;
    facts: readonly { key: string; value: string }[];
    annotations: readonly { key: string; value: string; observedAt: string }[];
    realityOrientation: string;
    rule: string;
  } }).care;
  assert.equal(care.root, dir);
  assert.deepEqual(care.facts, [{ key: "resident-name", value: "Margaret Ellis", category: "person" }], "the curated core rides the wire");
  assert.equal(care.annotations.length, 1, "the inert channel rides SEPARATELY — the boundary is visible in the payload");
  assert.equal(care.annotations[0]?.value, "Margaret Smith", "annotations are present for audit but never merged into facts");
  assert.equal(care.realityOrientation, "unset");
  assert.equal(care.rule, CARE_ASSERTION_RULE);
});

test("W213: absent capability 404s — capability withheld, fail closed", async (context) => {
  void seat(context);
  const bridge = await compose(context, {});
  const refused = await call(bridge, "/care", bridge.token);
  assert.equal(refused.status, 404);
  assert.deepEqual(refused.payload, { error: "not found" });
});

test("W213: the read is operator-token class — the verifier credential is refused", async (context) => {
  void seat(context);
  const bridge = await compose(context, { assistantCare: () => PROJECTION });
  const verifier = await call(bridge, "/care", bridge.verificationToken);
  assert.equal(verifier.status, 401);
});

test("W213: the hub stays POST-only — a GET on /care is 401", async (context) => {
  void seat(context);
  const bridge = await compose(context, { assistantCare: () => PROJECTION });
  const response = await fetch(`${bridge.url}/care`, {
    method: "GET",
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  assert.equal(response.status, 401, "the POST-only gate runs before dispatch");
});

test("W213 (review P2): a malformed core fabricates NOTHING — closure throws, the route is an honest 500, the relay names the absence", async (context) => {
  const dir = seat(context);
  const careDir = join(dir, "care");
  mkdirSync(careDir);
  writeFileSync(join(careDir, "core.yaml"), "facts: [not a list"); // present but unparseable

  // Closure level: the projection never returns a fabricated payload.
  assert.throws(() => readCareProjection(careDir), /invalid care core/, "the projection closure throws on a malformed core — it fabricates nothing");

  // Route level: the capability's throw hits the router's catch-all, so the
  // operator gets an honest 500 carrying the real message — never a 200 with
  // a `care` field.
  const bridge = await compose(context, { assistantCare: () => readCareProjection(careDir) });
  const answered = await call(bridge, "/care", bridge.token);
  assert.equal(answered.status, 500, "a malformed core is an honest server error, never a fabricated projection");
  const body = answered.payload as { care?: unknown; error?: unknown };
  assert.equal(body.care, undefined, "the 500 body has NO care field — nothing is fabricated");
  assert.match(String(body.error), /invalid care core/, "the 500 carries the real error message");

  // Relay level: the web service's fail-closed contract for ANY non-200 hub
  // answer holds here too — GET /api/care answers care: null with the hub's
  // real error as the reason (composed end-to-end: real hub + real web
  // server, the web-dispatch-relay pattern).
  const hubDir = join(dir, "hub");
  mkdirSync(hubDir);
  const graph = new TaskGraph([{ id: taskId("seed"), title: "seed", state: "READY", dependencies: [], requiredEvidence: [] } satisfies WorkflowTask]);
  const hub = await createWorkflowHub(seedApplication(), {
    discoveryDir: hubDir,
    graph,
    assistantCare: () => readCareProjection(careDir),
  });
  context.after(() => hub.close());
  const server = createWorkflowWebServer(seedApplication(), undefined, undefined, { hubDiscoveryDir: hubDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const relayed = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/care`);
  assert.equal(relayed.status, 200);
  const relayBody = (await relayed.json()) as { care: unknown; reason?: string };
  assert.equal(relayBody.care, null, "the relay answers the named absence, never a fabricated projection");
  assert.match(String(relayBody.reason), /invalid care core/, "the relay's reason is the hub's real error");
});
