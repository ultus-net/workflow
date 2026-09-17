import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { importSkills, loadProvenance, resolveSkillsDir, type VendorSource } from "../scripts/vendor-skills.mjs";

/**
 * Write a skill directory. A string description produces list_skills-visible
 * frontmatter; omitting it produces frontmatter WITHOUT a description — the
 * exact shape list_skills cannot see and the importer must report as a skip.
 */
function writeSkill(root: string, relative: string, description?: string, body = "# skill"): string {
  const dir = path.join(root, relative);
  mkdirSync(dir, { recursive: true });
  const name = path.basename(relative);
  const frontmatter = description === undefined
    ? "---\nname: other\n---\n"
    : `---\nname: ${name}\ndescription: ${description}\n---\n`;
  writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}\n${body}\n`);
  return dir;
}

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "vendor-skills-test-"));
}

const flatSource = (root: string): VendorSource => ({
  name: "flat-src",
  path: path.join(root, "flat-src"),
  include: ["skills/*"],
});

const nestedSource = (root: string): VendorSource => ({
  name: "nested-src",
  path: path.join(root, "nested-src"),
  include: ["skills/engineering/*", "skills/productivity/*"],
});

test("resolveSkillsDir matches the skills-mcp default-dir semantics: explicit > SKILLS_MCP_DIR > ~/.agents/skills", () => {
  const previous = process.env.SKILLS_MCP_DIR;
  try {
    process.env.SKILLS_MCP_DIR = "/tmp/env-skills";
    assert.equal(resolveSkillsDir(), "/tmp/env-skills", "env override wins over the default");
    assert.equal(resolveSkillsDir("/tmp/explicit-skills"), "/tmp/explicit-skills", "explicit arg wins over env");
    delete process.env.SKILLS_MCP_DIR;
    assert.equal(resolveSkillsDir(), path.join(process.env.HOME ?? "", ".agents", "skills"));
  } finally {
    if (previous === undefined) delete process.env.SKILLS_MCP_DIR;
    else process.env.SKILLS_MCP_DIR = previous;
  }
});

test("vendors flat and category-nested sources flattened, with provenance and honest skips", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const flat = path.join(work, "flat-src");
  const nested = path.join(work, "nested-src");
  writeSkill(flat, "skills/systematic-debugging", "four-phase root cause process");
  writeSkill(flat, "skills/writing-plans", "detailed implementation plans");
  writeSkill(nested, "skills/engineering/tdd", "red-green-refactor");
  writeSkill(nested, "skills/engineering/grill-me", "interview me about the plan");
  writeSkill(nested, "skills/productivity/handoff", "compact a handoff document");
  writeSkill(nested, "skills/deprecated/old-thing", "deprecated upstream");
  writeSkill(nested, "skills/engineering/no-description");

  const target = path.join(work, "skills");
  const report = await importSkills({ skillsDir: target, sources: [flatSource(work), nestedSource(work)] });

  assert.deepEqual([...report.imported].sort(), ["grill-me", "handoff", "systematic-debugging", "tdd", "writing-plans"]);
  assert.equal(report.refused.length, 0, JSON.stringify(report.refused));
  assert.deepEqual(
    report.skipped.map((skip) => skip.name),
    ["no-description"],
    "a SKILL.md without frontmatter description is invisible to list_skills and must be reported",
  );
  assert.match(report.skipped[0]?.reason ?? "", /description/);

  // Flattened layout: the category levels disappear, the scanner sees <name>/SKILL.md.
  for (const name of ["grill-me", "handoff", "systematic-debugging", "tdd", "writing-plans"]) {
    assert.equal(existsSync(path.join(target, name, "SKILL.md")), true, `${name} must land as <name>/SKILL.md`);
  }
  assert.equal(existsSync(path.join(target, "old-thing")), false, "deprecated category is not curated in");
  assert.equal(existsSync(path.join(target, "no-description")), false, "description-less skill is never imported");
  assert.equal(existsSync(path.join(target, "vendor-skills.json")), true, "provenance file is written at the target root");

  const provenance = loadProvenance(target);
  assert.equal(provenance["systematic-debugging"]?.source, "flat-src");
  assert.equal(provenance["systematic-debugging"]?.originPath, "skills/systematic-debugging");
  assert.equal(provenance["tdd"]?.source, "nested-src");
  assert.equal(provenance["tdd"]?.originPath, "skills/engineering/tdd");
  assert.equal(provenance["tdd"]?.commit, undefined, "local path sources carry no commit");
});

test("re-runs update owned skills in place and add newly selected ones", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/systematic-debugging", "debugging");
  const target = path.join(work, "skills");
  await importSkills({ skillsDir: target, sources: [flatSource(work)] });

  writeSkill(flat, "skills/systematic-debugging", "debugging", "updated body");
  writeSkill(flat, "skills/verification-before-completion", "verify before declaring success");
  const report = await importSkills({ skillsDir: target, sources: [flatSource(work)] });

  assert.deepEqual(report.updated, ["systematic-debugging"], "owned skills update, they do not duplicate");
  assert.deepEqual(report.imported, ["verification-before-completion"]);
  assert.match(readFileSync(path.join(target, "systematic-debugging", "SKILL.md"), "utf8"), /updated body/);
});

test("refuses to overwrite an unowned directory; --archive moves it aside and the import then succeeds", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/tdd", "upstream tdd");
  const target = path.join(work, "skills");
  writeSkill(target, "tdd", "the operator's own tdd", "handcrafted content");

  const refused = await importSkills({ skillsDir: target, sources: [flatSource(work)] });
  assert.equal(refused.refused.length, 1);
  assert.equal(refused.refused[0]?.name, "tdd");
  assert.match(refused.refused[0]?.reason ?? "", /not owned/);
  assert.match(readFileSync(path.join(target, "tdd", "SKILL.md"), "utf8"), /handcrafted content/,
    "the unowned directory is never touched");
  assert.equal(loadProvenance(target)["tdd"], undefined, "a refused import never claims ownership");

  const archived = await importSkills({ skillsDir: target, sources: [flatSource(work)], archive: true });
  assert.deepEqual(archived.archived, ["tdd"]);
  assert.match(readFileSync(path.join(target, "tdd", "SKILL.md"), "utf8"), /upstream tdd/,
    "after archiving, the vendored skill takes the name");
  const archiveRuns = readdirSync(path.join(target, ".archive")).sort();
  assert.equal(archiveRuns.length, 1, "one timestamped archive run");
  const archivedSkill = readFileSync(path.join(target, ".archive", archiveRuns[0] ?? "", "tdd", "SKILL.md"), "utf8");
  assert.match(archivedSkill, /handcrafted content/, "the handcrafted skill is preserved, not deleted");
  assert.equal(loadProvenance(target)["tdd"]?.source, "flat-src");
});

test("--archive moves only unowned skill-shaped directories; owned and non-skill directories stay", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/tdd", "upstream tdd");
  const target = path.join(work, "skills");
  await importSkills({ skillsDir: target, sources: [flatSource(work)] });

  // After the import tdd is owned; these two are the archive candidates.
  writeSkill(target, "handcrafted", "never vendored");
  mkdirSync(path.join(target, "not-a-skill")); // no SKILL.md: not skill-shaped
  const report = await importSkills({ skillsDir: target, sources: [flatSource(work)], archive: true });

  assert.deepEqual(report.archived, ["handcrafted"]);
  assert.equal(existsSync(path.join(target, "not-a-skill")), true, "non-skill directories are left alone");
  assert.equal(existsSync(path.join(target, "tdd", "SKILL.md")), true, "owned skills stay in place");
  const archiveRuns = readdirSync(path.join(target, ".archive")).sort();
  assert.equal(existsSync(path.join(target, ".archive", archiveRuns[0] ?? "", "handcrafted", "SKILL.md")), true);
});

test("prune removes only owned skills that left the selection; unowned directories survive", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/systematic-debugging", "debugging");
  writeSkill(flat, "skills/writing-plans", "plans");
  const target = path.join(work, "skills");
  await importSkills({ skillsDir: target, sources: [flatSource(work)] });
  writeSkill(target, "unowned-skill", "handcrafted, never vendored");

  rmSync(path.join(flat, "skills", "writing-plans"), { recursive: true, force: true }); // upstream removed it
  const report = await importSkills({ skillsDir: target, sources: [flatSource(work)], prune: true });

  assert.deepEqual(report.pruned, ["writing-plans"]);
  assert.equal(existsSync(path.join(target, "writing-plans")), false);
  assert.equal(existsSync(path.join(target, "systematic-debugging")), true);
  assert.equal(existsSync(path.join(target, "unowned-skill")), true, "prune never touches directories it does not own");
  assert.equal(loadProvenance(target)["writing-plans"], undefined, "pruned skills leave provenance");
});

test("prune is skipped when a source fails: a partial selection view must not delete live skills", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/systematic-debugging", "debugging");
  const target = path.join(work, "skills");
  await importSkills({ skillsDir: target, sources: [flatSource(work)] });

  const broken: VendorSource = {
    name: "broken-src",
    path: path.join(work, "does-not-exist"),
    include: ["skills/*"],
  };
  rmSync(path.join(flat, "skills", "systematic-debugging"), { recursive: true, force: true });
  const report = await importSkills({ skillsDir: target, sources: [broken], prune: true });

  assert.ok(report.problems.some((problem) => problem.includes("broken-src")), "the failed source is reported");
  assert.ok(
    report.problems.some((problem) => problem.includes("prune skipped")),
    "prune refuses to run on a partial view",
  );
  assert.equal(existsSync(path.join(target, "systematic-debugging")), true,
    "the live owned skill is kept despite leaving the (failed) selection");
});

test("duplicate skill names across sources are refused, not silently merged", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const left = path.join(work, "left-src");
  const right = path.join(work, "right-src");
  writeSkill(left, "skills/clash", "from the left source");
  writeSkill(right, "skills/clash", "from the right source");
  const target = path.join(work, "skills");

  const report = await importSkills({
    skillsDir: target,
    sources: [
      { name: "left", path: left, include: ["skills/*"] },
      { name: "right", path: right, include: ["skills/*"] },
    ],
  });

  assert.equal(report.refused.length, 1);
  assert.equal(report.refused[0]?.name, "clash");
  assert.match(report.refused[0]?.reason ?? "", /duplicate across sources \(left, right\)/);
  assert.equal(existsSync(path.join(target, "clash")), false, "neither duplicate is imported");
});

test("malformed provenance fails closed instead of silently taking ownership", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const target = path.join(work, "skills");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "vendor-skills.json"), "{ not json");
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/tdd", "upstream tdd");

  await assert.rejects(
    () => importSkills({ skillsDir: target, sources: [flatSource(work)] }),
    /invalid vendor-skills\.json/,
    "a corrupted ownership record must abort, never overwrite on top of an unknown state",
  );
});

test("a provenance record from a different schema version is refused, not adopted", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const target = path.join(work, "skills");
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "vendor-skills.json"),
    JSON.stringify({ version: 999, importedAt: "2026-01-01T00:00:00.000Z", skills: {} }),
  );
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/tdd", "upstream tdd");

  await assert.rejects(
    () => importSkills({ skillsDir: target, sources: [flatSource(work)] }),
    /unsupported vendor-skills\.json version/,
    "a record the importer cannot interpret must abort, never silently take ownership",
  );
});

test("a failed repo clone cleans up its temp directory and is reported, never fatal", async (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const before = new Set(readdirSync(tmpdir()));

  const report = await importSkills({
    skillsDir: path.join(work, "skills"),
    sources: [{ name: "bad-repo", repo: path.join(work, "no-such-repo"), include: ["skills/*"] }],
  });

  assert.ok(
    report.problems.some((problem) => problem.includes("bad-repo") && problem.includes("failed")),
    "the failed clone is reported as a source problem",
  );
  const leaked = readdirSync(tmpdir()).filter((entry) => entry.startsWith("vendor-skills-") && !before.has(entry));
  assert.equal(leaked.length, 0, "a failed clone must not leak its vendor-skills-* temp directory");
});

test("CLI --list is a dry run: it reports the plan and writes nothing", (t) => {
  const work = makeWorkspace();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const flat = path.join(work, "flat-src");
  writeSkill(flat, "skills/tdd", "upstream tdd");
  const target = path.join(work, "skills");
  const sourcesFile = path.join(work, "sources.json");
  writeFileSync(sourcesFile, JSON.stringify([{ name: "flat-src", path: flat, include: ["skills/*"] }]));

  const stdout = execFileSync(
    process.execPath,
    [path.resolve("scripts/vendor-skills.mjs"), "--dir", target, "--sources", sourcesFile, "--list"],
    { encoding: "utf8" },
  );

  assert.match(stdout, /dry run — nothing written/);
  assert.match(stdout, /tdd/);
  assert.equal(existsSync(path.join(target, "vendor-skills.json")), false, "a dry run never writes provenance");
  assert.equal(existsSync(path.join(target, "tdd")), false, "a dry run never writes skills");

  const real = execFileSync(
    process.execPath,
    [path.resolve("scripts/vendor-skills.mjs"), "--dir", target, "--sources", sourcesFile],
    { encoding: "utf8" },
  );
  assert.match(real, /imported: tdd/);
  assert.equal(existsSync(path.join(target, "tdd", "SKILL.md")), true);
});