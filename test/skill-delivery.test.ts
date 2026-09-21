import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanSkills } from "../mcp-toolbox/apps/skills-mcp/src/skills.js";

import {
  connectorReadablePaths,
  declaredSkillConnectors,
  provisionToolboxSkill,
  resolveToolboxCatalog,
  skillConnectorMounts,
} from "../src/integrations/toolbox-catalog.js";

/**
 * W080 mount half (delivery decision 2026-09-21, file-provisioning framing):
 * the hub provisions the generated `workflow-toolbox` skill into its own
 * delivery store (`SKILLS_MCP_DIR`, the directory skills-mcp scans) and
 * composes ONLY the skill's declared connectors into the launch config — the
 * hub-critical floor, never a wholesale mount, never an operator-disable
 * override. The store write is NOT native host skill injection: the host's
 * native skill tool stays denied and the model reaches content only through
 * the journaled `read_skill`.
 */

test("declared connectors are the built hub-critical floor, nothing more", () => {
  const built = resolveToolboxCatalog({ exists: () => true });
  const declared = declaredSkillConnectors(built);
  assert.deepEqual(declared, ["workflow-guard-mcp", "skills-mcp"]);

  // Unbuilt entries never mount from the declaration.
  const unbuiltGuard = built.map((entry) => entry.name === "workflow-guard-mcp" ? { ...entry, available: false } : entry);
  assert.deepEqual(declaredSkillConnectors(unbuiltGuard), ["skills-mcp"]);
});

test("skill connector mounts respect the operator disable and never double-mount", () => {
  const catalog = resolveToolboxCatalog({ exists: () => true });
  // The floor: guard + skills minus the delivery mount itself.
  const mounts = skillConnectorMounts(catalog, { alreadyMounted: ["skills-mcp"] });
  assert.deepEqual(mounts.map((mount) => mount.name), ["workflow-guard-mcp"]);
  assert.match(mounts[0]!.serverPath, /workflow-guard-mcp\/dist\/server\.js$/);

  // The containment binds (review P1 fix): dist + both pnpm node_modules
  // levels, deduplicated across connectors.
  const readable = connectorReadablePaths(mounts.map((mount) => mount.serverPath));
  assert.ok(readable.some((path) => path.endsWith("apps/workflow-guard-mcp/dist")));
  assert.ok(readable.some((path) => path.endsWith("apps/workflow-guard-mcp/node_modules")));
  assert.ok(readable.some((path) => path.endsWith("mcp-toolbox/node_modules")));
  const again = connectorReadablePaths([...mounts.map((mount) => mount.serverPath), ...mounts.map((mount) => mount.serverPath)]);
  assert.deepEqual(again, readable, "duplicate mounts add no duplicate binds");

  // An explicit operator disable always wins over the declaration.
  const disabled = skillConnectorMounts(catalog, { disabled: ["workflow-guard-mcp"], alreadyMounted: ["skills-mcp"] });
  assert.deepEqual(disabled, []);

  // Operator-enabled connectors arrive through the settings composition, so
  // the declaration must not duplicate them.
  const enabledElsewhere = skillConnectorMounts(catalog, { alreadyMounted: ["skills-mcp", "workflow-guard-mcp"] });
  assert.deepEqual(enabledElsewhere, []);
});

test("provisioning writes the skill into the delivery store exactly once per content state", (t) => {
  const skillsDir = mkdtempSync(join(tmpdir(), "wf-skill-provision-"));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  const catalog = resolveToolboxCatalog({ exists: () => true });

  const first = provisionToolboxSkill(skillsDir, catalog);
  assert.equal(first.written, true);
  const skillPath = join(skillsDir, "workflow-toolbox", "SKILL.md");
  assert.equal(existsSync(skillPath), true);
  const body = readFileSync(skillPath, "utf8");
  assert.match(body, /^---\nname: workflow-toolbox\n/);
  assert.match(body, /connectors:\n {2}- workflow-guard-mcp\n {2}- skills-mcp\n---/, "the delivered skill carries its declared connectors");

  // The store is scanned by skills-mcp: the directory name IS the skill name,
  // the frontmatter description is the metadata (skills.ts contract).
  // The store is scanned by skills-mcp: run the REAL scanner against the
  // provisioned store — the directory name is the skill name and the
  // frontmatter description is the metadata (the skills.ts contract).
  const scanned = scanSkills(skillsDir);
  const entry = scanned.find((skill) => skill.name === "workflow-toolbox");
  assert.notEqual(entry, undefined, "the provisioned skill must scan into skills-mcp metadata");
  assert.match(entry!.description, /workflow hub toolbox/i);

  // Idempotent: same content → no write churn on every session.
  const second = provisionToolboxSkill(skillsDir, catalog);
  assert.equal(second.written, false);
});

test("a corrupt or stale delivered skill is repaired on the next provision", (t) => {
  const skillsDir = mkdtempSync(join(tmpdir(), "wf-skill-repair-"));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  const catalog = resolveToolboxCatalog({ exists: () => true });

  const skillPath = join(skillsDir, "workflow-toolbox", "SKILL.md");
  mkdirSync(join(skillsDir, "workflow-toolbox"), { recursive: true });
  writeFileSync(skillPath, "---\nname: stale\ndescription: stale\n---\n", "utf8");

  const repaired = provisionToolboxSkill(skillsDir, catalog);
  assert.equal(repaired.written, true, "content drift is repaired, never left stale");
  assert.match(readFileSync(skillPath, "utf8"), /name: workflow-toolbox/);
});