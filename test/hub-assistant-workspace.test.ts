import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createWorkflowHubBridge, type AssistantWorkspaceListing } from "../src/integrations/hub-http.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W197 — the hub's assistant workspace listing read (the hub page overhaul,
// slice 2: the Workspace view). Pins the wire contract:
//   - the route is POST-class, like /snapshot and /assistant/routes; a GET is
//     401 (the hub's POST-only invariant holds at the gate).
//   - present capability -> 200 with { workspace: <listing> } verbatim (the
//     view projects the bounded directory read; the hub fabricates nothing).
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
  const dir = mkdtempSync(join(tmpdir(), "wf-assistant-workspace-"));
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
  options: { readonly listing?: AssistantWorkspaceListing } = {},
): Promise<Bridge> {
  void seat(context); // keep one temp seat per test for symmetry with siblings
  const listing = options.listing;
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
      ...(listing === undefined ? {} : { assistantWorkspace: () => listing }),
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

const LISTING: AssistantWorkspaceListing = {
  root: "/workspace",
  truncated: false,
  entries: [
    { name: "notes.md", kind: "file", size: 128, modifiedMs: 1_760_000_000_000 },
    { name: "src", kind: "directory", size: 0, modifiedMs: 1_760_000_001_000 },
  ],
};

test("W197: a composed capability answers POST /workspace with the listing verbatim", async (context) => {
  const bridge = await compose(context, { listing: LISTING });
  const answered = await call(bridge, "/workspace", bridge.token);
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.payload, { workspace: LISTING }, "the hub relays the composed listing verbatim — it fabricates nothing");
});

test("W197: an absent capability 404s (capability withheld, fail closed)", async (context) => {
  const bridge = await compose(context);
  const denied = await call(bridge, "/workspace", bridge.token);
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.payload, { error: "not found" });
});

test("W197: the read is operator-token class — the verifier credential is refused", async (context) => {
  const bridge = await compose(context, { listing: LISTING });
  const verifier = await call(bridge, "/workspace", bridge.verificationToken);
  assert.equal(verifier.status, 401);
});

test("W197: the hub stays POST-only — a GET on the route is 401", async (context) => {
  const bridge = await compose(context, { listing: LISTING });
  const response = await fetch(`${bridge.url}/workspace`, {
    method: "GET",
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  assert.equal(response.status, 401, "the POST-only gate runs before dispatch");
});
