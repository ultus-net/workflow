import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createWorkflowHubBridge, type HubBridgeCapabilities } from "../src/integrations/hub-http.js";
import { CARE_ASSERTION_RULE, readCareProjection, type CareProjection } from "../src/integrations/care-facts.js";
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
