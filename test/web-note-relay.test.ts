import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { createNoteStore, type NoteListing } from "../src/integrations/note-store.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { createWorkflowWebServer } from "../src/ui/web.js";

/**
 * W217 item 1 (P2): the W212 NOTE read relays, pinned end-to-end at the
 * production path — a REAL hub and a REAL web server, exercising the browser's
 * GET bridge onto the hub's POST-only note reads (`src/ui/web.ts`):
 *
 *   GET /api/notes        -> hub POST /notes      (listing; fail-closed)
 *   GET /api/note?name=.. -> hub POST /note-read   (status + payload verbatim)
 *
 * The comment at `src/ui/web.ts:341-342` claimed the care relay was "pinned
 * like its neighbors"; the NOTE relays had NO web-layer test. This file is that
 * pin, mirroring the W213 care-relay production-path pattern
 * (`test/hub-assistant-care.test.ts`).
 *
 * Pins:
 *   - `/api/notes` relays the hub's real listing verbatim.
 *   - `/api/notes` with NO hub (or the capability absent) is the named absence
 *     `{ notes: null, reason }` — never a fabricated table.
 *   - `/api/note?name=<seeded>` is a 200 with the real note body verbatim.
 *   - `/api/note` WITHOUT `name` is a 400 `{ error: "invalid note request" }`.
 *   - an unknown note relays the hub's 404 verbatim (never rewritten).
 *   - a confined-out/malformed name relays the hub's 400 verbatim.
 */

const SEED_TASKS: readonly WorkflowTask[] = [
  { id: taskId("seed"), title: "seed", state: "READY", dependencies: [], requiredEvidence: [] },
];

const seedApplication = (): WorkflowApplication =>
  new WorkflowApplication(new TaskGraph(SEED_TASKS.map((task) => ({ ...task }))), hostCapabilities({ transport: "native", authoritativePreMutation: true }));

const seat = (context: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "wf-web-note-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A real hub + a real web server composed over one discovery dir; returns the
 * web base URL. The hub is the browser-invisible authority the relay bridges. */
async function compose(context: TestContext, options: {
  readonly hubDiscoveryDir: string;
  readonly assistantNotes?: () => NoteListing;
  readonly assistantNoteRead?: (name: string) => ReturnType<ReturnType<typeof createNoteStore>["read"]>;
}): Promise<string> {
  const hub = await createWorkflowHub(seedApplication(), {
    discoveryDir: options.hubDiscoveryDir,
    graph: new TaskGraph(SEED_TASKS.map((task) => ({ ...task }))),
    ...(options.assistantNotes === undefined ? {} : { assistantNotes: options.assistantNotes }),
    ...(options.assistantNoteRead === undefined ? {} : { assistantNoteRead: options.assistantNoteRead }),
  });
  context.after(() => hub.close());
  const server = createWorkflowWebServer(seedApplication(), undefined, undefined, { hubDiscoveryDir: options.hubDiscoveryDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("W217: /api/notes relays the hub's real listing verbatim", async (context) => {
  const root = seat(context);
  const notes = join(root, "notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "2026-10-17-seam-stores.md"), "# seam stores\n");
  writeFileSync(join(notes, "2026-10-17-seam-stores.json"), JSON.stringify({ title: "Seam stores", source: "augur", findings: 0 }));
  const store = createNoteStore({ root: notes });
  const base = await compose(context, {
    hubDiscoveryDir: join(root, "hub"),
    assistantNotes: () => store.list(),
    assistantNoteRead: (name) => store.read(name),
  });

  const response = await fetch(`${base}/api/notes`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { notes: NoteListing | null; reason?: string };
  assert.equal(body.notes?.root, notes, "the relay answers the hub's REAL subtree root, never a placeholder");
  assert.equal(body.notes?.entries.length, 1);
  assert.equal(body.notes?.entries[0]?.name, "2026-10-17-seam-stores.md");
  assert.deepEqual(body.notes?.entries[0]?.meta, { title: "Seam stores", source: "augur", findings: 0 }, "the sidecar metadata rides the same lane verbatim");
});

test("W217: /api/notes with NO hub is the named absence, never a fabricated table", async (context) => {
  // An empty discovery dir: no hub is running, so the relay's upstream read
  // fails closed and the view renders its named-absence state.
  const orphan = seat(context);
  const server = createWorkflowWebServer(seedApplication(), undefined, undefined, { hubDiscoveryDir: orphan });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${base}/api/notes`);
  assert.equal(response.status, 200, "the relay answers its own 200 envelope; the ABSENCE rides the payload");
  const body = (await response.json()) as { notes: unknown; reason?: string };
  assert.equal(body.notes, null, "no hub -> notes: null, never a fabricated empty table");
  assert.equal(body.reason, "hub unavailable");
});

test("W217: /api/notes with the capability absent relays the hub's honest 404 as the named absence", async (context) => {
  const root = seat(context);
  const base = await compose(context, { hubDiscoveryDir: join(root, "hub") }); // no assistantNotes capability
  const response = await fetch(`${base}/api/notes`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { notes: unknown; reason?: string };
  assert.equal(body.notes, null, "a withheld capability is the named absence, never a fabricated table");
  assert.equal(body.reason, "not found", "the reason is the hub's real error, not a rewritten one");
});

test("W217: /api/note?name=<seeded> relays the hub's 200 and note body verbatim", async (context) => {
  const root = seat(context);
  const notes = join(root, "notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "one.md"), "# One\n\nbody\n");
  writeFileSync(join(notes, "one.json"), JSON.stringify({ title: "One", findings: 2 }));
  const store = createNoteStore({ root: notes });
  const base = await compose(context, {
    hubDiscoveryDir: join(root, "hub"),
    assistantNotes: () => store.list(),
    assistantNoteRead: (name) => store.read(name),
  });

  const response = await fetch(`${base}/api/note?name=one.md`);
  assert.equal(response.status, 200, "the hub's 200 passes through unchanged");
  const body = (await response.json()) as { note: { name: string; byteSize: number; body: string; meta: unknown } };
  assert.equal(body.note.name, "one.md");
  assert.equal(body.note.body, "# One\n\nbody\n", "the note body reaches the browser verbatim");
  assert.equal(body.note.byteSize, 12);
  assert.deepEqual(body.note.meta, { title: "One", findings: 2 });
});

test("W217: /api/note WITHOUT name is a 400 at the relay (never a hub round-trip)", async (context) => {
  const root = seat(context);
  const notes = join(root, "notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "one.md"), "# One\n");
  const store = createNoteStore({ root: notes });
  const base = await compose(context, {
    hubDiscoveryDir: join(root, "hub"),
    assistantNoteRead: (name) => store.read(name),
  });

  const response = await fetch(`${base}/api/note`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid note request" });
});

test("W217: /api/note?name=<unknown> passes the hub's 404 through verbatim", async (context) => {
  const root = seat(context);
  const notes = join(root, "notes");
  mkdirSync(notes);
  const store = createNoteStore({ root: notes });
  const base = await compose(context, {
    hubDiscoveryDir: join(root, "hub"),
    assistantNoteRead: (name) => store.read(name),
  });

  const response = await fetch(`${base}/api/note?name=nope.md`);
  assert.equal(response.status, 404, "an unknown note is the hub's honest 404, not rewritten to 200");
  assert.deepEqual(await response.json(), { error: "not found" });
});

test("W217: /api/note?name=<confined-out> passes the hub's 400 through verbatim", async (context) => {
  const root = seat(context);
  const notes = join(root, "notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "real.md"), "# real\n");
  const store = createNoteStore({ root: notes });
  const base = await compose(context, {
    hubDiscoveryDir: join(root, "hub"),
    assistantNoteRead: (name) => store.read(name),
  });

  // A traversal name is confined out at the hub store and answered as a 400
  // naming the rule; the relay must not rewrite that status or body.
  const response = await fetch(`${base}/api/note?name=${encodeURIComponent("../outside-secret.md")}`);
  assert.equal(response.status, 400, "a confined-out name is the hub's 400, not a fabricated 404/200");
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /bare basenames/, "the refusal pins the confinement RULE, not just an error mentioning a note");
});

test("W217: /api/note with NO hub is the named absence on the single-note lane", async (context) => {
  // The sibling of the /api/notes no-hub pin: an empty discovery dir means the
  // hub-availability read fails closed, so hubPost answers its own
  // {error:"hub unavailable"} and the relay must pass that through verbatim
  // (the browser never holds a hub token, so this is the honest face).
  const orphan = seat(context);
  const server = createWorkflowWebServer(seedApplication(), undefined, undefined, { hubDiscoveryDir: join(orphan, "hub") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${base}/api/note?name=anything.md`);
  const body = (await response.json()) as { error?: string };
  assert.equal(body.error, "hub unavailable", "no hub -> the relay's own availability error, never a fabricated note");
});
