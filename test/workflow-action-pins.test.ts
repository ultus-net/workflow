import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * W185 (campaign iteration 1): every GitHub Action reference must be pinned to
 * an immutable commit SHA, not a mutable major-version tag.
 *
 * `uses: actions/checkout@v4` is a mutable pointer: whoever controls the
 * `v4` tag controls what executes in this repository's CI, including the
 * `publish` job whose token carries `contents: write` and `packages: write`.
 * Pinning to the 40-hex commit the tag currently resolves to makes the
 * workflow content-addressed; a moved tag cannot change what runs.
 *
 * This pin is shape-only (it cannot call the GitHub API from CI), so it
 * enforces the invariant that is checkable offline: each `uses:` names a
 * 40-hex SHA and keeps the human-readable tag in a trailing `# comment`.
 * The SHA-to-tag correspondence is verified once, against the live tags,
 * and recorded in docs/agents/ledger.md (campaign iteration 2).
 *
 * Scope: the ROOT `.github/workflows/`. The vendored `mcp-toolbox/` subtree
 * carries its own `.github/workflows/ci.yml`, but GitHub runs only the root
 * repository's workflows — a nested `.github/` is inert — so it is not
 * scanned here (its action refs are upstream's, not this repo's CI surface).
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowsDir = join(repoRoot, ".github", "workflows");

/** Docker ecosystem actions pin a vN major; everything else here pins vN.N.N. */
const usesLine = /^\s*(?:- )?uses:\s*(\S+)\s*(?:#\s*(\S.*))?$/;

function workflowFiles(): string[] {
  return readdirSync(workflowsDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
}

test("W185: every workflow action reference is pinned to a 40-hex commit SHA", () => {
  const files = workflowFiles();
  assert.ok(files.length > 0, "expected at least one workflow file");
  for (const file of files) {
    const lines = readFileSync(join(workflowsDir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = usesLine.exec(line);
      if (!match) return;
      const ref = match[1] ?? "";
      // Local composite actions (`./path`) and docker:// refs are out of scope.
      if (ref.startsWith("./") || ref.startsWith("docker://")) return;
      const at = ref.lastIndexOf("@");
      assert.ok(at > 0, `${file}:${index + 1}: action reference has no @ref: ${ref}`);
      const pinned = ref.slice(at + 1);
      assert.match(
        pinned,
        /^[0-9a-f]{40}$/,
        `${file}:${index + 1}: action "${ref}" is not SHA-pinned (a mutable tag can be retargeted)`,
      );
    });
  }
});

test("W185: every SHA-pinned action keeps its human-readable tag in a trailing comment", () => {
  for (const file of workflowFiles()) {
    const lines = readFileSync(join(workflowsDir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = usesLine.exec(line);
      if (!match) return;
      const ref = match[1] ?? "";
      if (ref.startsWith("./") || ref.startsWith("docker://")) return;
      assert.ok(
        match[2],
        `${file}:${index + 1}: SHA-pinned action "${ref}" needs a trailing "# <tag>" comment so a human can read the ref`,
      );
    });
  }
});
