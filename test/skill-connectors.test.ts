import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOLBOX_CATALOG,
  toolboxSkillBody,
  validateSkillConnectors,
} from "../src/integrations/toolbox-catalog.js";
import { resolveToolboxCatalog } from "../src/integrations/toolbox-catalog.js";

/**
 * W080 (schema half) — the generated `workflow-toolbox` skill's optional
 * `connectors` declaration, validated against the toolbox catalog fail-loud.
 * The mount half is deliberately absent: native host skill injection stays
 * off per the 2026-09-15 skill-delivery gate, so these pins hold the schema
 * and the validation seam that a (gated) delivery layer would consume.
 */

test("the optional connectors declaration validates against the catalog", () => {
  assert.deepEqual(validateSkillConnectors(undefined), [], "absent means no connector claims");
  const names = validateSkillConnectors(["workflow-guard-mcp", "skills-mcp"]);
  assert.deepEqual(names, ["workflow-guard-mcp", "skills-mcp"]);
  // Trimmed entries are accepted; the catalog is the single source of truth.
  assert.deepEqual(validateSkillConnectors(["  skills-mcp "]), ["skills-mcp"]);
});

test("unknown, non-string, and duplicate connector declarations fail loud", () => {
  assert.throws(() => validateSkillConnectors(["not-a-real-connector"]), /unknown connector.*'not-a-real-connector'/);
  assert.throws(() => validateSkillConnectors(["workflow-guard-mcp", "nope-mcp"]), /unknown connector/);
  assert.throws(() => validateSkillConnectors([42]), /non-empty strings/);
  assert.throws(() => validateSkillConnectors([""]), /non-empty strings/);
  assert.throws(() => validateSkillConnectors(["workflow-guard-mcp", "workflow-guard-mcp"]), /duplicate connector/);
  assert.throws(() => validateSkillConnectors("workflow-guard-mcp"), /must be an array/);
  // Validation is against the PASS-IN catalog, not only the shipped manifest.
  assert.deepEqual(validateSkillConnectors(["custom"], [{ name: "custom", description: "x" }]), ["custom"]);
  assert.throws(() => validateSkillConnectors(["workflow-guard-mcp"], [{ name: "custom", description: "x" }]), /unknown connector/);
});

test("the generated skill body stays byte-identical without a declaration (W077 corpus shape)", () => {
  const body = toolboxSkillBody(resolveToolboxCatalog({ exists: () => true }));
  assert.match(body, /^---\nname: workflow-toolbox\n/);
  assert.match(body, /version: 1\n---/);
  assert.doesNotMatch(body, /^connectors:/m, "no declaration means no connector claims");
});

test("a declared connector list renders into the frontmatter and bumps the version", () => {
  const body = toolboxSkillBody(resolveToolboxCatalog({ exists: () => true }), {
    connectors: ["workflow-guard-mcp", "skills-mcp"],
  });
  assert.match(body, /version: 2\n/);
  assert.match(body, /connectors:\n {2}- workflow-guard-mcp\n {2}- skills-mcp\n---/);
  // An invalid declaration fails loud at composition time, not at mount time.
  assert.throws(() => toolboxSkillBody(TOOLBOX_CATALOG.map((entry) => ({ ...entry, transport: "stdio" as const, serverPath: "/x", available: true })), { connectors: ["bogus"] }), /unknown connector/);
  // An empty declaration is honest "no claims", not a version bump.
  const empty = toolboxSkillBody(resolveToolboxCatalog({ exists: () => true }), { connectors: [] });
  assert.match(empty, /version: 1\n---/);
});