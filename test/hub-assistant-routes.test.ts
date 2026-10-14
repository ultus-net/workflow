import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createWorkflowHubBridge, type AssistantRouteSummary } from "../src/integrations/hub-http.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W195 — the hub's assistant route summary read (the hub page overhaul, slice
// 1: the Routes view). Pins the wire contract:
//   - the route is POST-class, like /snapshot and /board/tasks; a GET is 401
//     (the hub's POST-only invariant holds at the gate).
//   - present capability -> 200 with the summary verbatim (the view projects
//     operator config; the hub fabricates nothing).
//   - absent capability -> 404 { error: "not found" } (capability withheld,
//     fail closed, like the other optional registries).
//   - the verifier credential does NOT authorize the read (operator-token
//     class only).

interface Bridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

const seat = (context: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "wf-assistant-routes-"));
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

async function compose(
  context: TestContext,
  options: { readonly summary?: AssistantRouteSummary } = {},
): Promise<Bridge> {
  void seat(context); // keep one temp seat per test for symmetry with siblings
  const summary = options.summary;
  const bridge = await createWorkflowHubBridge(
    seedApplication(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ...(summary === undefined ? {} : { assistantRoutes: () => summary }),
    },
  );
  context.after(() => bridge.close());
  return bridge;
}

const call = async (bridge: Bridge, path: string, token: string): Promise<{ status: number; payload: unknown }> => {
  const response = await fetch(`${bridge.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return { status: response.status, payload: await response.json() };
};

const SUMMARY: AssistantRouteSummary = {
  routes: [
    { route: "coding", systemPrompt: "you write code", identities: ["7", "operator"], withheld: [] },
    { route: "tutor", systemPrompt: "you tutor", identities: [], withheld: [] },
    { route: "care", systemPrompt: "you care", identities: ["42"], withheld: ["file_write", "shell"] },
  ],
};

test("W195: a composed capability answers POST /assistant/routes with the summary verbatim", async (context) => {
  const bridge = await compose(context, { summary: SUMMARY });
  const answered = await call(bridge, "/assistant/routes", bridge.token);
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.payload, SUMMARY, "the hub relays the composed summary verbatim — it fabricates nothing");
});

test("W195: an absent capability 404s (capability withheld, fail closed)", async (context) => {
  const bridge = await compose(context);
  const denied = await call(bridge, "/assistant/routes", bridge.token);
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.payload, { error: "not found" });
});

test("W195: the read is operator-token class — the verifier credential is refused", async (context) => {
  const bridge = await compose(context, { summary: SUMMARY });
  const verifier = await call(bridge, "/assistant/routes", bridge.verificationToken);
  assert.equal(verifier.status, 401);
});

test("W195: the hub stays POST-only — a GET on the route is 401", async (context) => {
  const bridge = await compose(context, { summary: SUMMARY });
  const response = await fetch(`${bridge.url}/assistant/routes`, {
    method: "GET",
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  assert.equal(response.status, 401, "the POST-only gate runs before dispatch");
});
