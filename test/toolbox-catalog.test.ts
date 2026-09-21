import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  TOOLBOX_CATALOG,
  packageRoot,
  resolveToolboxCatalog,
  toolboxServerPath,
  toolboxSkillBody,
} from "../src/integrations/toolbox-catalog.js";

/**
 * The settings connector catalog (docs/ideas/hub-control-plane.md). The
 * manifest is executed against the real vendored corpus so the settings
 * panel can never list a connector that does not exist, describe one
 * falsely, or miss one that ships.
 */

test("the catalog covers exactly the vendored mcp-toolbox apps", () => {
  const appsDir = join(packageRoot(), "mcp-toolbox", "apps");
  const onDisk = new Set(readdirNames(appsDir));
  const manifest = new Set(TOOLBOX_CATALOG.map((app) => app.name));
  assert.deepEqual([...manifest].sort(), [...onDisk].sort());
});

test("every catalog description matches the vendored package.json", () => {
  for (const app of TOOLBOX_CATALOG) {
    const manifestPath = join(packageRoot(), "mcp-toolbox", "apps", app.name, "package.json");
    // No skip case: the retired workflow-fs-exec-mcp is out of the manifest
    // (f525b35's retirement completed 2026-09-21), so every listed app is a
    // real vendored package whose description must stay in lockstep.
    const description = JSON.parse(readFileSync(manifestPath, "utf8")).description as string | undefined;
    assert.equal(description, app.description, `${app.name} description drifted from its package.json`);
  }
});

test("every vendored connector entrypoint is built", () => {
  for (const app of TOOLBOX_CATALOG) {
    assert.equal(
      existsSync(toolboxServerPath(packageRoot(), app.name)),
      true,
      `${app.name} is unbuilt; run: npm run toolbox:build`,
    );
  }
});

test("availability resolution uses the injected probe and keeps entries pure", () => {
  const present = resolveToolboxCatalog({ exists: () => true });
  assert.equal(present.length, TOOLBOX_CATALOG.length);
  assert.equal(present.every((entry) => entry.available), true);
  assert.equal(present[0]!.transport, "stdio");

  const absent = resolveToolboxCatalog({ exists: () => false });
  assert.equal(absent.every((entry) => entry.available === false), true);
  assert.equal(absent.every((entry) => entry.serverPath.endsWith(join("dist", "server.js"))), true);
});

test("the W075 skill body is generated from the catalog and stays in lockstep with the corpus", () => {
  const body = toolboxSkillBody(resolveToolboxCatalog());
  // Every connector appears with its catalog description and a truthful
  // build state; the body is a proper skill file (frontmatter, bounded doc).
  for (const app of TOOLBOX_CATALOG) {
    assert.ok(body.includes(`**${app.name}**`), `the skill body must list ${app.name}`);
    assert.ok(body.includes(app.description), `the skill body must carry ${app.name}'s catalog description`);
  }
  assert.match(body, /---\nname: workflow-toolbox\n/, "frontmatter names the skill");
  assert.match(body, /# Workflow toolbox/, "the body carries the section heading");
  assert.match(body, /never authorizes/, "the body states the advisory posture");
  assert.ok(!body.includes("undefined") && !body.includes("[object Object]"), "no malformed interpolation");

  // Availability is stated from the resolved entry, not hardcoded: a corpus
  // where everything is built reads "available"; an unbuilt corpus reads
  // "unbuilt" — the body cannot claim a build that does not exist.
  const unbuilt = toolboxSkillBody(resolveToolboxCatalog({ exists: () => false }));
  assert.match(unbuilt, /unbuilt/, "an unbuilt corpus must be stated as unbuilt");
  assert.ok(!unbuilt.includes("(available)"), "no entry may claim availability it does not have");
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}
