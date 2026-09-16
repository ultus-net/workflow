import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type TaskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { applySkillGating, loadSkillsLevelMap, resolveSkillsLevelMap, skillGatingFor, type SkillsLevelMap } from "../src/pedagogy/skill-gating.js";

/**
 * Plan Tasks F2/F3: the learner-level skill mapping and the application-layer
 * delivery precondition. Delivery is enforced; adherence is not — a read_skill
 * observation is a precondition for mutations, never task evidence.
 */

function appWith(tasks: WorkflowTask[]): WorkflowApplication {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
  );
  return application;
}

const WORK: WorkflowTask = { id: taskId("work"), title: "Work", state: "READY", dependencies: [], requiredEvidence: [] };

function startWork(application: WorkflowApplication): TaskId {
  const started = application.transition(WORK.id, "IN_PROGRESS");
  assert.equal(started.kind, "accepted");
  application.selectActiveTask(WORK.id);
  return WORK.id;
}

test("mutations are denied until every required skill is delivered for THIS task", () => {
  const application = appWith([{ ...WORK, state: "READY" }]);
  const workId = startWork(application);
  application.setTaskRequiredSkills(workId, ["test-driven-development", "code-review"]);

  const denied = application.authorize({
    sessionId: "s", taskId: workId, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["src/a.ts"], input: {},
  });
  assert.equal(denied.kind, "deny");
  assert.equal(denied.code, "SKILL_DELIVERY_REQUIRED");
  assert.match(denied.reason, /test-driven-development/);

  // Delivering one of two required skills is not enough.
  application.recordSkillRead("test-driven-development");
  const stillDenied = application.authorize({
    sessionId: "s", taskId: workId, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["src/a.ts"], input: {},
  });
  assert.equal(stillDenied.kind === "deny" && stillDenied.code === "SKILL_DELIVERY_REQUIRED" ? "SKILL_DELIVERY_REQUIRED" : undefined, "SKILL_DELIVERY_REQUIRED");

  application.recordSkillRead("code-review");
  const allowed = application.authorize({
    sessionId: "s", taskId: workId, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["src/a.ts"], input: {},
  });
  assert.deepEqual(allowed, { kind: "allow" });
});

test("skill reads are per-task: a new task must re-read its required skills", () => {
  const application = appWith([{ ...WORK, state: "READY" }]);
  const first = startWork(application);
  application.setTaskRequiredSkills(first, ["code-review"]);
  application.recordSkillRead("code-review");
  assert.equal(application.authorize({
    sessionId: "s", taskId: first, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["a.ts"], input: {},
  }).kind, "allow");

  // A second task with the same requirement starts fresh.
  const secondId = taskId("second");
  application.addTask({ id: secondId, title: "Second", dependencies: [], requiredEvidence: [] });
  application.transition(secondId, "IN_PROGRESS");
  application.selectActiveTask(secondId);
  application.setTaskRequiredSkills(secondId, ["code-review"]);
  const denied = application.authorize({
    sessionId: "s", taskId: secondId, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["a.ts"], input: {},
  });
  assert.equal(denied.kind === "deny" && denied.code === "SKILL_DELIVERY_REQUIRED" ? "SKILL_DELIVERY_REQUIRED" : undefined, "SKILL_DELIVERY_REQUIRED", "the first task's read must not carry over");

  application.recordSkillRead("code-review", secondId);
  assert.equal(application.authorize({
    sessionId: "s", taskId: secondId, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["a.ts"], input: {},
  }).kind, "allow");
});

test("skill reads never become task evidence and non-mutating actions are unaffected", () => {
  const application = appWith([{ ...WORK, state: "READY" }]);
  const workId = startWork(application);
  application.setTaskRequiredSkills(workId, ["code-review"]);

  const readAllowed = application.authorize({
    sessionId: "s", taskId: workId, tool: "read_file", capability: "read",
    mutating: false, subjects: ["src/a.ts"], input: {},
  });
  assert.deepEqual(readAllowed, { kind: "allow" });

  application.recordSkillRead("code-review");
  const snapshot = application.snapshot();
  assert.equal(snapshot.tasks.find((task) => task.id === workId)?.state, "IN_PROGRESS");
  assert.equal(snapshot.evidence.some((evidence) => evidence.subject.includes("code-review")), false,
    "a skill read must never be recorded as verification evidence");

  // Clearing the requirement removes the gate.
  application.setTaskRequiredSkills(workId, []);
  assert.equal(application.authorize({
    sessionId: "s", taskId: workId, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["a.ts"], input: {},
  }).kind, "allow");
});

test("recordSkillRead fails closed without an active task and validates names", () => {
  const application = appWith([{ ...WORK, state: "READY" }]);
  assert.throws(() => application.recordSkillRead("code-review"), /no active task/);
  const started = appWith([{ ...WORK, state: "READY" }]);
  const workId = startWork(started);
  assert.throws(() => started.recordSkillRead("  "), /non-empty/);
  assert.throws(() => started.setTaskRequiredSkills(taskId("ghost"), ["x"]), /unknown task/);
  void workId;
});

test("skillGatingFor maps pedagogical modes and fails closed on malformed maps", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-skill-gating-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(loadSkillsLevelMap(dir), undefined, "no levels.json means no map");
  const unconfigured = skillGatingFor("autonomous", undefined);
  assert.deepEqual(unconfigured, { mode: "autonomous", unlocked: [], required: [], configured: false });

  writeFileSync(join(dir, "levels.json"), JSON.stringify({
    "learn-to-code": { unlocked: ["test-driven-development"], required: ["test-driven-development"] },
    "socratic-tutor": { unlocked: ["test-driven-development", "code-review"], required: [] },
  }), "utf8");
  const map = loadSkillsLevelMap(dir);
  const gated = skillGatingFor("learn-to-code", map);
  assert.deepEqual(gated, {
    mode: "learn-to-code",
    unlocked: ["test-driven-development"],
    required: ["test-driven-development"],
    configured: true,
  });
  assert.equal(skillGatingFor("walkthrough", map).configured, false,
    "a mode with no entry has no skill contract");

  writeFileSync(join(dir, "levels.json"), "{ not json", "utf8");
  assert.throws(() => loadSkillsLevelMap(dir), /invalid levels\.json/);
});

test("applySkillGating binds and clears the mode's required skills on the active task", () => {
  const application = appWith([{ ...WORK, state: "READY" }]);
  const workId = startWork(application);
  const map: SkillsLevelMap = {
    "learn-to-code": { unlocked: ["test-driven-development"], required: ["test-driven-development"] },
    autonomous: { unlocked: ["test-driven-development", "code-review"], required: [] },
  };
  const mutation = {
    sessionId: "s", taskId: workId, tool: "write_to_file", capability: "mutation",
    mutating: true, subjects: ["a.ts"], input: {},
  } as const;

  applySkillGating(application, "learn-to-code", map);
  const denied = application.authorize(mutation);
  assert.equal(denied.kind === "deny" && denied.code === "SKILL_DELIVERY_REQUIRED" ? "SKILL_DELIVERY_REQUIRED" : undefined,
    "SKILL_DELIVERY_REQUIRED", "the mode's required skills gate the active task's mutations");

  application.recordSkillRead("test-driven-development");
  assert.equal(application.authorize(mutation).kind, "allow");

  // Switching to a mode with no required skills clears the precondition.
  applySkillGating(application, "autonomous", map);
  assert.equal(application.authorize(mutation).kind, "allow");

  // An unconfigured mode or absent map composes to no requirement.
  applySkillGating(application, "walkthrough", map);
  applySkillGating(application, "learn-to-code", undefined);
  assert.equal(application.authorize(mutation).kind, "allow");

  // Fails closed on the caller's contract: no active task means no silent skip.
  const bare = appWith([{ ...WORK, state: "READY" }]);
  assert.throws(() => applySkillGating(bare, "learn-to-code", map), /no active workflow task selected/);
});

test("resolveSkillsLevelMap mirrors the skills-mcp directory contract", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-skill-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const defaultDir = join(home, ".agents", "skills");

  assert.equal(resolveSkillsLevelMap(undefined, home), undefined, "no levels.json in the default dir means no map");

  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(join(defaultDir, "levels.json"), JSON.stringify({
    "learn-to-code": { unlocked: [], required: ["test-driven-development"] },
  }), "utf8");
  assert.deepEqual(resolveSkillsLevelMap(undefined, home), {
    "learn-to-code": { unlocked: [], required: ["test-driven-development"] },
  });

  const override = mkdtempSync(join(tmpdir(), "wf-skill-override-"));
  t.after(() => rmSync(override, { recursive: true, force: true }));
  writeFileSync(join(override, "levels.json"), JSON.stringify({
    autonomous: { unlocked: ["code-review"], required: [] },
  }), "utf8");
  assert.deepEqual(resolveSkillsLevelMap(override, home), {
    autonomous: { unlocked: ["code-review"], required: [] },
  }, "a SKILLS_MCP_DIR-style override wins over the default dir");

  assert.deepEqual(resolveSkillsLevelMap("  ", home), {
    "learn-to-code": { unlocked: [], required: ["test-driven-development"] },
  }, "a blank override falls back to the default dir");

  writeFileSync(join(override, "levels.json"), "{ not json", "utf8");
  assert.throws(() => resolveSkillsLevelMap(override, home), /invalid levels\.json/,
    "a malformed map refuses startup instead of running ungated");
});