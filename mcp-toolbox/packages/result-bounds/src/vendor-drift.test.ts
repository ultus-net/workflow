import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { boundText } from "./index.js";

/**
 * The canonical helper is vendored (copied verbatim) into the apps that adopt
 * it, because packed npm artifacts must stay self-contained. This drift
 * guard fails when a vendored copy diverges from the canonical source —
 * regenerate the copies instead of editing them.
 */

const here = dirname(fileURLToPath(import.meta.url));
// Works from src (tsx) and from dist (compiled test runs).
const canonicalPath = [resolve(here, "index.ts"), resolve(here, "..", "src", "index.ts")].find((candidate) =>
  existsSync(candidate),
);
assert.ok(canonicalPath !== undefined, "canonical result-bounds source not found");
const canonical = readFileSync(canonicalPath, "utf8");
const vendoredApps = [
  resolve(here, "..", "..", "..", "apps", "code-intelligence-mcp", "src", "vendor", "result-bounds.ts"),
  resolve(here, "..", "..", "..", "apps", "test-intelligence-mcp", "src", "vendor", "result-bounds.ts"),
  resolve(here, "..", "..", "..", "apps", "skills-mcp", "src", "vendor", "result-bounds.ts"),
  resolve(here, "..", "..", "..", "apps", "workflow-fs-exec-mcp", "src", "vendor", "result-bounds.ts"),
];

test("vendored result-bounds copies match the canonical source", () => {
  for (const vendoredPath of vendoredApps) {
    const vendored = readFileSync(vendoredPath, "utf8");
    assert.ok(
      vendored.endsWith(canonical),
      `vendored copy diverged from the canonical source: ${vendoredPath} — regenerate it from packages/result-bounds/src/index.ts`,
    );
  }
});

test("the canonical export surface is stable for vendoring", () => {
  assert.equal(typeof boundText, "function");
});
