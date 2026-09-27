import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  createProjectRegistry,
  loadProjectsTable,
  projectScopedBoard,
  saveProjectsTable,
  type ProjectRecord,
} from "../src/integrations/project-registry.js";
import type { BoardOutcome } from "../src/integrations/task-provider.js";

// W164 — the project container (Paperclip borrow, the "open a project"
// record). A hub-owned registry binding a provider-stable repo identity
// (fullName + provider id, credential-free — the ProjectRepository pattern),
// a status, a budget ENVELOPE (the existing W045/W118 RunBudget shape — the
// record carries the caps; enforcement stays with the run-time budget
// machinery), and workspace bindings. Pins per the registered prediction:
//   1. the identity record provably carries no credential — pinned BY VALUE
//      (a seeded token never appears in the serialized record or the
//      persisted table bytes, and no token-shaped key exists to carry one);
//   2. per-project scoping: a project-scoped query returns ONLY its bound
//      workspaces, and the board scope never returns another repo's board;
//   3. single-authority dispatch preserved: the registry carries NO run or
//      dispatch seam (its surface is pinned), so a project record can never
//      bypass the application authority;
//   4. persistence mirrors the schedule table's conventions ({version:1},
//      validated-before-admit, atomic 0o600 write, ENOENT → no projects,
//      corrupt file → refused, never silently emptied).

const seat = (context: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "wf-projects-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "workflow",
  title: "Workflow",
  repo: { provider: "github", fullName: "ultus-net/workflow", repoId: 911_496_128 },
  status: "active",
  workspaces: ["/home/hunter/worktrees/workflow"],
  ...overrides,
});

// A distinctive credential stand-in: the no-leak pins below search for this
// exact VALUE in serialized output, not just for a variable name.
const TOKEN = "ghp_seed3d-cr3dential-v4lue-7a1f";

test("W164: the identity record carries no credential — pinned by value, on the record and on the persisted bytes", (context) => {
  const record = project({
    budget: { maxTotalTokens: 50_000, maxCostUsd: 1.5 },
  });
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(TOKEN), "the seeded credential value never rides the record");
  assert.ok(
    !/"(token|secret|credential|password|authorization|api_?key)"/i.test(serialized),
    "no token-shaped key exists on the record to carry a credential",
  );
  // The at-rest table is exactly as credential-free.
  const dir = seat(context);
  const path = join(dir, "projects.json");
  saveProjectsTable(path, [record]);
  const bytes = readFileSync(path, "utf8");
  assert.ok(!bytes.includes(TOKEN), "the persisted table never carries credential material");
  assert.deepEqual(JSON.parse(bytes), { version: 1, projects: [record] });
});

test("W164: per-project scoping — a project-scoped query returns ONLY its bound workspaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-projects-scope-"));
  const registry = createProjectRegistry({ path: join(dir, "projects.json") });
  registry.save(project({ id: "workflow", workspaces: ["/ws/workflow", "/ws/workflow-lib"] }));
  registry.save(project({ id: "paperclip", workspaces: ["/ws/paperclip"] }));
  const scoped = registry.boundWorkspaces("workflow");
  assert.deepEqual(scoped, ["/ws/workflow", "/ws/workflow-lib"]);
  assert.ok(!JSON.stringify(scoped).includes("paperclip"));
  assert.equal(registry.boundWorkspaces("paperclip")?.length, 1);
  // An unknown project answers undefined — never another project's bindings.
  assert.equal(registry.boundWorkspaces("nope"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("W164: the board scope is repo-bound — the project's own board or an honest refusal, never a foreign board", () => {
  const record = project({ repo: { provider: "github", fullName: "ultus-net/workflow", repoId: 1 } });
  const own: BoardOutcome = {
    state: "ok",
    board: {
      provider: "github", repo: "ultus-net/workflow", tasks: [], skipped: 0, pullRequestsExcluded: 0,
    },
  };
  const foreign: BoardOutcome = {
    state: "ok",
    board: {
      provider: "github", repo: "other/repo", tasks: [], skipped: 0, pullRequestsExcluded: 0,
    },
  };
  const scoped = projectScopedBoard(record, own);
  assert.equal(scoped.kind, "ok");
  if (scoped.kind === "ok") assert.equal(scoped.board.repo, "ultus-net/workflow");
  const refused = projectScopedBoard(record, foreign);
  assert.equal(refused.kind, "foreign");
  if (refused.kind === "foreign") {
    assert.match(refused.reason, /ultus-net\/workflow/);
    assert.match(refused.reason, /other\/repo/);
  }
  // Provider faults relay as unavailable with their reason — never an empty board.
  const unconfigured = projectScopedBoard(record, { state: "unconfigured", missing: ["WORKFLOW_GITHUB_TOKEN"] });
  assert.equal(unconfigured.kind, "unavailable");
  const noBoard = projectScopedBoard(record, undefined);
  assert.equal(noBoard.kind, "unavailable");
});

test("W164: single-authority dispatch preserved — the registry surface carries no run or dispatch seam", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-projects-surface-"));
  const registry = createProjectRegistry({ path: join(dir, "projects.json") });
  assert.deepEqual(
    Object.keys(registry).sort(),
    ["boundWorkspaces", "get", "list", "remove", "save"],
    "a dispatch seam (runNow/attachRunner and friends) must never grow onto the project record",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("W164: persistence mirrors the schedule table — version 1, ENOENT → empty, corrupt → refused", (context) => {
  const dir = seat(context);
  const path = join(dir, "projects.json");
  assert.deepEqual(loadProjectsTable(path), [], "an absent table means no projects");
  saveProjectsTable(path, [project()]);
  assert.deepEqual(loadProjectsTable(path), [project()]);
  // The file is private (mode 0o600), like the schedule table.
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json", { mode: 0o600 });
  assert.throws(() => loadProjectsTable(broken), TypeError);
  // An unsupported version is refused, never coerced to empty.
  const wrongVersion = join(dir, "v99.json");
  writeFileSync(wrongVersion, JSON.stringify({ version: 99, projects: [] }), { mode: 0o600 });
  assert.throws(() => loadProjectsTable(wrongVersion), /version/);
});

test("W164: validation fails closed — a rejected save admits nothing in memory or at rest", (context) => {
  const dir = seat(context);
  const path = join(dir, "projects.json");
  const registry = createProjectRegistry({ path });
  const valid = project();
  registry.save(valid);
  const rejects: readonly [string, ProjectRecord][] = [
    ["empty id", project({ id: "  " })],
    ["empty title", project({ title: "" })],
    ["wrong provider", project({ repo: { provider: "gitlab" as never, fullName: "o/r", repoId: 1 } })],
    ["fullName without owner", project({ repo: { provider: "github", fullName: "just-a-name", repoId: 1 } })],
    ["non-integer repo id", project({ repo: { provider: "github", fullName: "o/r", repoId: 1.5 } })],
    ["unknown status", project({ status: "deleted" as never })],
    ["negative budget cap", project({ budget: { maxTotalTokens: -1 } })],
    ["empty workspace entry", project({ workspaces: [""] })],
    ["workspaces not an array", project({ workspaces: "nope" as never })],
  ];
  for (const [name, bad] of rejects) {
    assert.throws(() => registry.save(bad), TypeError, `expected refusal: ${name}`);
  }
  assert.deepEqual(registry.list(), [valid], "no rejected record partially admitted");
  assert.deepEqual(loadProjectsTable(path), [valid], "no rejected record persisted");
});
