import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W196: the Tier-B CI suite manifest.
//
// The curated CI-safe suite used to ride one long package.json `test:ci`
// line, so every test-adding PR edited that single line and conflicted with
// the next one to merge (PRs #560/#561 both hit it). The list now lives in
// test/ci-suites.txt, one path per line. A sorted file keeps concurrent
// additions on different lines so git auto-merges them; this suite pins the
// properties that make that true — sorted order, uniqueness, real files —
// and pins that `test:ci` routes through the runner (never a glob).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "test", "ci-suites.txt");

function manifestEntries(): string[] {
  return readFileSync(manifestPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

test("W196: the CI suite manifest is sorted — the property that avoids merge conflicts", () => {
  const entries = manifestEntries();
  assert.ok(entries.length > 0, "the manifest must enumerate at least one suite");
  assert.deepEqual(
    entries,
    [...entries].sort(),
    "test/ci-suites.txt must stay in sorted order — a sorted file is what keeps two " +
      "concurrent suite additions on different lines so git merges them without a conflict",
  );
});

test("W196: the CI suite manifest has no duplicate entries", () => {
  const entries = manifestEntries();
  assert.equal(new Set(entries).size, entries.length, "no suite may be listed twice");
});

test("W196: every manifested suite exists and is a .test.ts file", () => {
  const entries = manifestEntries();
  const missing = entries.filter((rel) => !existsSync(join(repoRoot, rel)));
  assert.deepEqual(missing, [], `manifest names file(s) that do not exist: ${missing.join(", ")}`);
  const wrongShape = entries.filter((rel) => !rel.endsWith(".test.ts") || !rel.startsWith("test/"));
  assert.deepEqual(wrongShape, [], `entries must be test/*.test.ts paths: ${wrongShape.join(", ")}`);
});

test("W196: the manifest pins itself, so CI enforces the manifest's own discipline", () => {
  const entries = manifestEntries();
  assert.ok(
    entries.includes("test/ci-suites-manifest.test.ts"),
    "this suite must list itself in test/ci-suites.txt so the pin runs in CI",
  );
});

test("W196: `test:ci` routes through the runner and stays enumeration-by-name (never a glob)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const ci = pkg.scripts["test:ci"];
  assert.equal(
    ci,
    "node scripts/run-ci-suites.mjs",
    "`test:ci` must invoke the manifest runner; the enumeration lives in test/ci-suites.txt",
  );
  assert.ok(!ci.includes("*"), "`test:ci` must never carry a glob (docs/CI.md section 4)");
});
