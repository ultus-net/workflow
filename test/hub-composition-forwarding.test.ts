import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createWorkflowHub, resolveHubDiscoveryPath } from "../src/integrations/workflow-hub.js";
import { createNoteStore } from "../src/integrations/note-store.js";
import { CARE_ASSERTION_RULE, readCareProjection } from "../src/integrations/care-facts.js";

// W212 P0 — the PRODUCTION composition path (`createWorkflowHub`) silently
// dropped the assistant-workspace family: the CLI passed assistantWorkspace
// (W197), assistantNotes, and assistantNoteRead (W212), but the options type
// never declared them and the capabilities object never forwarded them — and
// the spread-call shape (`...(cap === undefined ? {} : { key: cap })`) let the
// unknown keys bypass TypeScript's excess-property check, so both routes were
// alive in bridge-level tests and dead in the real hub forever. This file
// composes the hub the way `src/cli/hub.ts` does and drives the routes through
// the published discovery file, so a forwarding regression like that fails
// here instead of shipping again.

interface Hub {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

const seat = (context: TestContext): { readonly dir: string; readonly workspace: string; readonly notes: string; readonly care: string } => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-compose-"));
  const workspace = join(dir, "workspace");
  const notes = join(workspace, "notes");
  const care = join(dir, "care");
  mkdirSync(notes, { recursive: true });
  mkdirSync(care);
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, workspace, notes, care };
};

const seedGraph = (): TaskGraph => {
  const task: WorkflowTask = {
    id: taskId("seed"),
    title: "seed",
    state: "READY",
    dependencies: [],
    requiredEvidence: [],
  };
  return new TaskGraph([task]);
};

async function compose(
  context: TestContext,
  dir: string,
  options: Parameters<typeof createWorkflowHub>[1],
): Promise<Hub> {
  const graph = seedGraph();
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  const hub = await createWorkflowHub(application, { discoveryDir: dir, graph, ...options });
  context.after(() => hub.close());
  const discovery = JSON.parse(readFileSync(resolveHubDiscoveryPath(dir), "utf8")) as { endpoint: string; token: string };
  return { url: discovery.endpoint, token: discovery.token, verificationToken: hub.verificationToken, close: () => hub.close() };
}

const call = async (hub: Hub, path: string, token: string, body: unknown = {}): Promise<{ status: number; payload: unknown }> => {
  const response = await fetch(`${hub.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
};

test("W212 P0: the production composition forwards the workspace + notes capabilities to live routes", async (context) => {
  const { dir, workspace, notes, care } = seat(context);
  writeFileSync(join(notes, "one.md"), "# One\n\nbody\n");
  writeFileSync(join(notes, "one.json"), JSON.stringify({ title: "One", findings: 1 }));
  writeFileSync(join(workspace, "sibling.txt"), "plain file");
  writeFileSync(join(care, "core.yaml"), ["facts:", "  - key: resident-name", "    value: Margaret Ellis", "    category: person", ""].join("\n"));
  const store = createNoteStore({ root: notes });
  const hub = await compose(context, dir, {
    assistantWorkspace: () => {
      // The same closure shape src/cli/hub.ts builds; a canned bounded
      // listing over the seat keeps this test a forwarding pin, not a
      // re-test of the enumerator (that is W197's own suite's job).
      return { root: workspace, truncated: false, entries: [{ name: "sibling.txt", kind: "file", size: 10, modifiedMs: 1_761_000_000_000 }] };
    },
    assistantNotes: () => store.list(),
    assistantNoteRead: (name) => store.read(name),
    // W213: the care projection — the same readCareProjection closure shape
    // src/cli/hub.ts builds off WORKFLOW_CARE_FACTS.
    assistantCare: () => readCareProjection(care),
  });

  const listedWorkspace = await call(hub, "/workspace", hub.token);
  assert.deepEqual(listedWorkspace.payload, {
    workspace: { root: workspace, truncated: false, entries: [{ name: "sibling.txt", kind: "file", size: 10, modifiedMs: 1_761_000_000_000 }] },
  }, "POST /workspace reaches the bridge through createWorkflowHub with the listing verbatim");

  const listed = await call(hub, "/notes", hub.token);
  assert.equal(listed.status, 200, "POST /notes reaches the bridge through createWorkflowHub");
  const listing = (listed.payload as { notes: { root: string; entries: readonly { name: string; meta: unknown }[] } }).notes;
  assert.equal(listing.root, notes);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["one.md"]);
  assert.deepEqual(listing.entries[0]?.meta, { title: "One", findings: 1 }, "the sidecar rides the production path verbatim");

  const read = await call(hub, "/note-read", hub.token, { name: "one.md" });
  assert.equal(read.status, 200, "POST /note-read reaches the bridge through createWorkflowHub");
  const note = (read.payload as { note: { body: string } }).note;
  assert.equal(note.body, "# One\n\nbody\n");

  const careAnswered = await call(hub, "/care", hub.token);
  assert.equal(careAnswered.status, 200, "POST /care reaches the bridge through createWorkflowHub");
  const projection = (careAnswered.payload as { care: { root: string; facts: readonly { key: string }[]; rule: string } }).care;
  assert.equal(projection.root, care);
  assert.deepEqual(projection.facts.map((fact) => fact.key), ["resident-name"], "the care projection rides the production path verbatim");
  assert.equal(projection.rule, CARE_ASSERTION_RULE);
});

test("W212 P0: absent capabilities still 404 through the production composition (fail closed)", async (context) => {
  const { dir } = seat(context);
  const hub = await compose(context, dir, {});
  for (const path of ["/workspace", "/notes", "/note-read", "/care"]) {
    const refused = await call(hub, path, hub.token, path === "/note-read" ? { name: "one.md" } : {});
    assert.equal(refused.status, 404, "withheld capability stays fail-closed through createWorkflowHub (" + path + ")");
    assert.deepEqual(refused.payload, { error: "not found" });
  }
});

test("W215: the production hub's posture carries no budgetIncidents — the named degraded registry, never a fabricated row", async (context) => {
  const { dir } = seat(context);
  const hub = await compose(context, dir, {});
  const snapshot = await call(hub, "/snapshot", hub.token);
  assert.equal(snapshot.status, 200, "POST /snapshot answers through the production composition");
  const posture = (snapshot.payload as { posture: { counts: { budgetIncidents: number | null }; degraded: readonly string[] } }).posture;
  assert.equal("budgetIncidents" in posture, false, "the hub composes no session registry — the incident producer is web-side (W215); the dead hub seam is removed");
  assert.equal(posture.counts.budgetIncidents, null, "the count keeps its honest null");
  assert.equal(posture.degraded.includes("per-session budget state"), true, "the absent registry stays named");
});

test("W212 P0: the forwarded routes keep the token classes through the production composition", async (context) => {
  const { dir, notes, care } = seat(context);
  writeFileSync(join(notes, "one.md"), "# One\n");
  const store = createNoteStore({ root: notes });
  const hub = await compose(context, dir, {
    assistantNotes: () => store.list(),
    assistantNoteRead: (name) => store.read(name),
    assistantCare: () => readCareProjection(care),
  });
  // The verifier credential is refused on both reads (operator-token class).
  assert.equal((await call(hub, "/notes", hub.verificationToken)).status, 401);
  assert.equal((await call(hub, "/note-read", hub.verificationToken, { name: "one.md" })).status, 401);
  assert.equal((await call(hub, "/care", hub.verificationToken)).status, 401, "the verifier credential is refused on /care too");
  // The confinement gate holds end-to-end through the forwarded capability.
  const traversal = await call(hub, "/note-read", hub.token, { name: "../escape.md" });
  assert.equal(traversal.status, 400);
});
