import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createWorkflowHubBridge, type HubBridgeCapabilities } from "../src/integrations/hub-http.js";
import { createNoteStore, type NoteListing } from "../src/integrations/note-store.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W212 — the hub's notes subtree routes (decision-brief Option A). Pins the
// wire contract:
//   - both routes are POST-class, like /workspace and /snapshot; a GET is 401
//     (the hub's POST-only invariant holds at the gate).
//   - POST /notes answers { notes: <listing> } verbatim (bounded, sorted,
//     sidecar metadata or null); POST /note-read answers { note } verbatim.
//   - absent capability -> 404 { error: "not found" } (capability withheld,
//     fail closed, like the other optional registries).
//   - the verifier credential does NOT authorize the reads (operator-token
//     class only).
//   - a malformed/confined-out name is a 400 naming the rule; an unknown note
//     is a 404; an over-cap note is an honest 413 with the count.

interface Bridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

const seat = (context: TestContext): { readonly root: string; readonly notes: string } => {
  const root = mkdtempSync(join(tmpdir(), "wf-hub-note-"));
  const notes = join(root, "notes");
  mkdirSync(notes);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, notes };
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
  void seat(context); // keep one temp seat per test for symmetry with siblings
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

const LISTING: NoteListing = {
  root: "/workspace/notes",
  truncated: false,
  entries: [
    { name: "2026-10-17-seam-stores.md", byteSize: 512, modifiedMs: 1_761_000_000_000, meta: { title: "Seam stores", source: "augur", producedAt: "2026-10-17T00:00:00.000Z", blocked: false, findings: 0 } },
    { name: "raw-note.md", byteSize: 64, modifiedMs: 1_761_000_001_000, meta: null },
  ],
};

test("W212: a composed capability answers POST /notes with the listing verbatim", async (context) => {
  const bridge = await compose(context, { assistantNotes: () => LISTING });
  const answered = await call(bridge, "/notes", bridge.token);
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.payload, { notes: LISTING }, "the hub relays the composed listing verbatim — it fabricates nothing");
});

test("W212: POST /note-read answers the note body verbatim", async (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "one.md"), "# One\n\nbody\n");
  writeFileSync(join(notes, "one.json"), JSON.stringify({ title: "One", findings: 2 }));
  const store = createNoteStore({ root: notes });
  const bridge = await compose(context, { assistantNotes: () => store.list(), assistantNoteRead: (name) => store.read(name) });
  const answered = await call(bridge, "/note-read", bridge.token, { name: "one.md" });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.payload, {
    note: {
      name: "one.md",
      byteSize: 12,
      modifiedMs: (answered.payload as { note: { modifiedMs: number } }).note.modifiedMs,
      meta: { title: "One", findings: 2 },
      body: "# One\n\nbody\n",
    },
  });
});

test("W212: absent capabilities 404 — capability withheld, fail closed", async (context) => {
  const bridge = await compose(context, {});
  const listed = await call(bridge, "/notes", bridge.token);
  assert.equal(listed.status, 404);
  assert.deepEqual(listed.payload, { error: "not found" });
  const read = await call(bridge, "/note-read", bridge.token, { name: "one.md" });
  assert.equal(read.status, 404);
  assert.deepEqual(read.payload, { error: "not found" });
});

test("W212: the reads are operator-token class — the verifier credential is refused", async (context) => {
  const bridge = await compose(context, { assistantNotes: () => LISTING, assistantNoteRead: (name) => createNoteStore({ root: name }).read(name) });
  const verifierList = await call(bridge, "/notes", bridge.verificationToken);
  assert.equal(verifierList.status, 401);
  const verifierRead = await call(bridge, "/note-read", bridge.verificationToken, { name: "one.md" });
  assert.equal(verifierRead.status, 401);
});

test("W212: the hub stays POST-only — a GET on the note routes is 401", async (context) => {
  const bridge = await compose(context, { assistantNotes: () => LISTING });
  for (const path of ["/notes", "/note-read"]) {
    const response = await fetch(`${bridge.url}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    assert.equal(response.status, 401, "the POST-only gate runs before dispatch (" + path + ")");
  }
});

test("W212: a malformed or confined-out name is a 400 naming the rule, never a resolved path", async (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "real.md"), "# real\n");
  writeFileSync(join(tmpdir(), "outside-secret.md"), "# outside\n");
  const store = createNoteStore({ root: notes });
  const bridge = await compose(context, { assistantNoteRead: (name) => store.read(name) });
  // Structural: a missing or non-string name is a 400 at the route.
  const missing = await call(bridge, "/note-read", bridge.token, {});
  assert.equal(missing.status, 400);
  const nonString = await call(bridge, "/note-read", bridge.token, { name: 42 });
  assert.equal(nonString.status, 400);
  // Confinement: traversal, absolute resolution, and separators are 400s.
  for (const bad of ["../outside-secret.md", join(notes, "real.md"), "/etc/passwd", "a/b.md", "real.txt"]) {
    const refused = await call(bridge, "/note-read", bridge.token, { name: bad });
    assert.equal(refused.status, 400, "confined out: " + JSON.stringify(bad));
    assert.match(String((refused.payload as { error: string }).error), /note/, "the refusal names its rule");
  }
});

test("W212: an unknown note is an honest 404", async (context) => {
  const { notes } = seat(context);
  const store = createNoteStore({ root: notes });
  const bridge = await compose(context, { assistantNoteRead: (name) => store.read(name) });
  const unknown = await call(bridge, "/note-read", bridge.token, { name: "nope.md" });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.payload, { error: "not found" });
});

test("W212: an over-cap note is an honest 413 with the count, never a truncated body", async (context) => {
  const { notes } = seat(context);
  writeFileSync(join(notes, "big.md"), "x".repeat(64));
  const store = createNoteStore({ root: notes, maxBytes: 10 });
  const bridge = await compose(context, { assistantNoteRead: (name) => store.read(name) });
  const overCap = await call(bridge, "/note-read", bridge.token, { name: "big.md" });
  assert.equal(overCap.status, 413);
  assert.match(String((overCap.payload as { error: string }).error), /64 bytes/, "the refusal carries the real byte count");
});
