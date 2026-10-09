import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { isEntrypoint } from "../src/cli/entrypoint.js";

/**
 * The control-plane image's CMD and operator commands start a package `bin`,
 * which npm/pnpm install as a SYMLINK (`/usr/local/bin/workflow-hub` ->
 * `.../dist/cli/hub.js`). Node does not realpath `argv[1]`, so the pre-fix
 * lexical guards (`import.meta.url === pathToFileURL(argv[1])`, or a filename
 * regex) never matched a symlinked bin: the daemon started, no-opped, and
 * exited 0 (measured in-container 2026-10-09 — `workflow-opencode-server`
 * exited without opening the gateway). `isEntrypoint` canonicalizes argv[1]
 * first, so a symlinked bin resolves to its real module.
 */

test("isEntrypoint: matches the module reached through a symlinked bin", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-entry-"));
  try {
    const real = join(dir, "real.js");
    writeFileSync(real, "export {};\n");
    const link = join(dir, "bin-link");
    symlinkSync(real, link);
    const moduleUrl = pathToFileURL(real).href;
    // The lexical compare against the SYMLINK fails; realpath makes it match.
    assert.equal(pathToFileURL(link).href === moduleUrl, false, "the raw symlink path must not compare equal");
    assert.equal(isEntrypoint(moduleUrl, link), true);
    assert.equal(isEntrypoint(moduleUrl, real), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isEntrypoint: a different module and a missing argv[1] never match", () => {
  const moduleUrl = pathToFileURL("/somewhere/else.js").href;
  assert.equal(isEntrypoint(moduleUrl, "/definitely/not/this.js"), false);
  assert.equal(isEntrypoint(moduleUrl, undefined), false);
  assert.equal(isEntrypoint(moduleUrl, ""), false);
});
