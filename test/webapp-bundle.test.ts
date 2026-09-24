import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWebappEntry } from "../src/ui/webapp/bundle.js";

// W124 (the compiled-launcher web surface): bundle.ts resolved its esbuild
// entry as a SIBLING of the module file — true in source mode (tsx runs
// src/ui/webapp/bundle.ts beside main.tsx) but broken in the compiled
// layout (tsc emits dist/ui/webapp/main.js; main.tsx never exists there),
// so `node dist/cli/workflow.js` surface 1 failed esbuild with "Could not
// resolve .../dist/ui/webapp/main.tsx". The resolution is layout-aware:
// the source sibling first, then the src copy three directories up from a
// dist location — the LESS-0012 dual-surface parity rule applied to the
// webapp bundle seam.

const srcModuleUrl = (root: string): string =>
  `file://${join(root, "src", "ui", "webapp", "bundle.ts").replace(/\\/g, "/")}`;
const distModuleUrl = (root: string): string =>
  `file://${join(root, "dist", "ui", "webapp", "bundle.js").replace(/\\/g, "/")}`;

test("W124: a source-layout module resolves its main.tsx sibling", () => {
  const root = mkdtempSync(join(tmpdir(), "w124-src-"));
  mkdirSync(join(root, "src", "ui", "webapp"), { recursive: true });
  writeFileSync(join(root, "src", "ui", "webapp", "main.tsx"), "export {};");
  assert.equal(
    resolveWebappEntry(srcModuleUrl(root)),
    join(root, "src", "ui", "webapp", "main.tsx"),
    "the source layout keeps the sibling resolution",
  );
});

test("W124: a dist-layout module resolves the src copy three directories up", () => {
  const root = mkdtempSync(join(tmpdir(), "w124-dist-"));
  mkdirSync(join(root, "dist", "ui", "webapp"), { recursive: true });
  mkdirSync(join(root, "src", "ui", "webapp"), { recursive: true });
  writeFileSync(join(root, "src", "ui", "webapp", "main.tsx"), "export {};");
  assert.equal(
    resolveWebappEntry(distModuleUrl(root)),
    join(root, "src", "ui", "webapp", "main.tsx"),
    "the compiled layout bundles the src entry (dist never contains a .tsx)",
  );
});

test("W124: neither layout present fails with both candidates named", () => {
  const root = mkdtempSync(join(tmpdir(), "w124-empty-"));
  mkdirSync(join(root, "dist", "ui", "webapp"), { recursive: true });
  assert.throws(
    () => resolveWebappEntry(distModuleUrl(root)),
    /dist[\\/]ui[\\/]webapp[\\/]main\.tsx.* and .*src[\\/]ui[\\/]webapp[\\/]main\.tsx\)/s,
    "the error names BOTH candidates in order (a message dropping either fails the pin)",
  );
});

test("W124: the real repo resolves its entry in both layouts", () => {
  // The real source layout: src/ui/webapp/main.tsx exists in the checkout.
  const repoRoot = process.cwd();
  assert.equal(resolveWebappEntry(srcModuleUrl(repoRoot)), join(repoRoot, "src", "ui", "webapp", "main.tsx"));
  // The real compiled layout: dist/ui/webapp/bundle.js resolves the src copy
  // (the operator's `npm run build && node dist/cli/workflow.js` surface 1).
  assert.equal(
    resolveWebappEntry(distModuleUrl(repoRoot)),
    join(repoRoot, "src", "ui", "webapp", "main.tsx"),
    "the compiled launcher bundles from the src entry",
  );
});