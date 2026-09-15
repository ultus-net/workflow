import assert from "node:assert/strict";
import { test } from "node:test";

import { gateSkills, isSkillName, loadSkillsLevelMap, readSkillContent, scanSkills } from "../src/skills.js";
import { fixtureSkillsDir, malformedMapDir } from "./fixtures.js";

test("scanSkills returns sorted metadata only, never content", () => {
  const skills = scanSkills(fixtureSkillsDir);
  assert.deepEqual(skills.map((skill) => skill.name), [
    "advanced-refactoring",
    "code-review",
    "test-driven-development",
  ]);
  assert.equal(skills.every((skill) => skill.description !== undefined), true);
  assert.equal(JSON.stringify(skills).includes("Write a failing test"), false, "content never leaks into discovery");
});

test("readSkillContent delivers full content and fails closed on bad names", () => {
  const content = readSkillContent(fixtureSkillsDir, "test-driven-development");
  assert.match(content, /# Test-Driven Development/);
  assert.throws(() => readSkillContent(fixtureSkillsDir, "../fixtures/skills/test-driven-development"), /invalid skill name/);
  assert.throws(() => readSkillContent(fixtureSkillsDir, "missing-skill"), /unknown skill/);
  assert.equal(isSkillName("a/b"), false);
  assert.equal(isSkillName(".."), false);
  assert.equal(isSkillName("good-name.v2"), true);
});

test("gateSkills is off without a level map or level, active with an entry, closed on a missing entry", () => {
  const skills = scanSkills(fixtureSkillsDir);

  const off = gateSkills(skills, undefined, "learn-to-code");
  assert.equal(off.gating, "off");
  assert.equal(off.skills.length, 3);

  const map = {
    "learn-to-code": { unlocked: ["test-driven-development"], required: ["test-driven-development"] },
    autonomous: { unlocked: ["test-driven-development", "code-review", "advanced-refactoring"], required: [] },
  };
  const active = gateSkills(skills, map, "learn-to-code");
  assert.equal(active.gating, "active");
  assert.deepEqual(active.skills.map((skill) => skill.name), ["test-driven-development"]);

  const closed = gateSkills(skills, map, "unknown-mode");
  assert.equal(closed.gating, "closed", "a configured level with no map entry must not silently unlock everything");
  assert.deepEqual(closed.skills, []);

  const ungated = gateSkills(skills, map, undefined);
  assert.equal(ungated.gating, "off", "no level configured means availability gating is explicitly off");
});

test("loadSkillsLevelMap is optional and fails closed on malformed maps", () => {
  assert.equal(loadSkillsLevelMap(fixtureSkillsDir), undefined, "no levels.json means no map");
  assert.throws(
    () => loadSkillsLevelMap(malformedMapDir()),
    /invalid levels\.json/,
    "a malformed gating config must throw, not silently gate everything open",
  );
});