import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import packageJson from "../package.json" with { type: "json" };

/**
 * W086 follow-up — the stated install surface is pinned to the declared one.
 * `npm install -g .` installs every bin in package.json's `bin` map, so the
 * operator-facing summary printed by scripts/install.mjs must be derived
 * from that map rather than a hardcoded list that can silently rot (the
 * stale five-bin summary shipped alongside ten declared bins), and the
 * README's Install/Commands sections must name every bin plus the operator
 * verbs the launcher actually dispatches (W076 `doctor`, W086
 * `install fleet`). This pin reads the live artifacts so the stated surface
 * cannot drift from the real one again.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bins = Object.keys(packageJson.bin).sort();

test("the setup summary derives its bin list from package.json (no stale hardcoded list)", () => {
  const source = readFileSync(join(repoRoot, "scripts", "install.mjs"), "utf8");
  assert.match(
    source,
    /Object\.keys\(pkg\.bin\)/,
    "install.mjs must derive the printed bin list from package.json's bin map",
  );
  assert.ok(
    !source.includes("Installed bins: workflow, workflow-tui, workflow-hub, workflow-monitor, workflow-shell"),
    "the stale hardcoded five-bin summary is gone (it omitted newer bins)",
  );
});

test("the README install list carries every declared bin", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const missing = bins.filter((bin) => !readme.includes(`\`${bin}\``));
  assert.deepEqual(missing, [], `README must name every package.json bin (missing: ${missing.join(", ")})`);
});

test("the README commands section states the launcher's operator verbs", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  assert.ok(readme.includes("`workflow doctor`"), "`workflow doctor` (W076) must be documented in README");
  assert.ok(readme.includes("`workflow install fleet`"), "`workflow install fleet` (W086) must be documented in README");
});