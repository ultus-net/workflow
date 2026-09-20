import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  TOOLBOX_CATALOG,
  packageRoot,
  resolveToolboxCatalog,
  toolboxServerPath,
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

test("every catalog description matches the vendored package.json (except the artifact-only server)", () => {
  for (const app of TOOLBOX_CATALOG) {
    const manifestPath = join(packageRoot(), "mcp-toolbox", "apps", app.name, "package.json");
    if (!existsSync(manifestPath)) continue; // workflow-fs-exec-mcp ships dist-only
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

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}
