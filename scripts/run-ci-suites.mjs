#!/usr/bin/env node
// Tier-B evidence runner (W155 design, docs/CI.md section 4).
//
// The curated CI-safe suite is enumerated by name in test/ci-suites.txt,
// one path per line (blank lines and #-comments ignored). The list used to
// live inline on a single package.json `test:ci` line; because every
// test-adding PR edited that one line, any two such PRs conflicted on
// merge. A sorted manifest keeps concurrent additions on different lines,
// so git merges them without a conflict, and the enumeration-by-name rule
// (never a glob — a glob would silently admit a PTY/agent/hub-spawning
// suite) is preserved: adding a suite is still a deliberate edit.
//
// Usage: npm run test:ci
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "test", "ci-suites.txt");

const suites = readFileSync(manifestPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

if (suites.length === 0) {
  console.error(`run-ci-suites: no suites enumerated in ${manifestPath}`);
  process.exit(1);
}

// Fail closed if the manifest names a suite that no longer exists, rather
// than letting node report it as a missing test file mid-run.
const { existsSync } = await import("node:fs");
const missing = suites.filter((rel) => !existsSync(join(repoRoot, rel)));
if (missing.length > 0) {
  console.error(`run-ci-suites: manifest names ${missing.length} missing file(s):`);
  for (const rel of missing) console.error(`  ${rel}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...suites],
  { stdio: "inherit", cwd: repoRoot },
);

if (result.error) {
  console.error(`run-ci-suites: failed to launch the test runner: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
