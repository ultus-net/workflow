import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * C2 (mcp-toolbox → control-plane conversion): the vendored workflow-guard
 * policy core is copied byte-for-byte into `src/integrations/guard-policy/`
 * so the hub/seat guard runs IN-PROCESS (no subprocess, no stale-dist class)
 * while the vendored app keeps its own self-contained copy and behavioral
 * suite. This drift guard fails when the in-process copy diverges from the
 * app's source — regenerate the copies instead of editing them in place.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const canonicalDir = join(repoRoot, "mcp-toolbox", "apps", "workflow-guard-mcp", "src");
const vendoredDir = join(repoRoot, "src", "integrations", "guard-policy");

// The portable policy modules (never `server.ts`/`claude-hook.ts`, which are
// app-specific hosts). Mirrors the copy list in the C2 commit.
const POLICY_MODULES = [
  "boundary-policy.ts",
  "git-policy.ts",
  "interpreter-policy.ts",
  "mcp-policy.ts",
  "path-policy.ts",
  "policy.ts",
  "pr-policy.ts",
  "redirect.ts",
  "shell-policy.ts",
  "shell.ts",
] as const;

test("the in-process guard-policy copy contains exactly the portable modules", () => {
  const found = readdirSync(vendoredDir).filter((name) => name.endsWith(".ts") && name !== "index.ts").sort();
  assert.deepEqual(found, [...POLICY_MODULES].sort());
});

for (const module of POLICY_MODULES) {
  test(`guard-policy/${module} is byte-identical to the vendored app source`, () => {
    const canonicalPath = join(canonicalDir, module);
    const vendoredPath = join(vendoredDir, module);
    assert.ok(existsSync(canonicalPath), `canonical ${canonicalPath} missing`);
    assert.ok(existsSync(vendoredPath), `vendored copy ${vendoredPath} missing`);
    const canonical = readFileSync(canonicalPath, "utf8");
    const vendored = readFileSync(vendoredPath, "utf8");
    assert.equal(
      vendored,
      canonical,
      `src/integrations/guard-policy/${module} drifted from ${canonicalPath}; regenerate the copy (cp) instead of editing it`,
    );
  });
}
