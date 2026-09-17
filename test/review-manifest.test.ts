import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  deriveReviewCoverageManifest,
  manifestDigest,
  parseReviewStatus,
  renderReviewManifestText,
  reviewCoverageGaps,
  reviewObligationsForPath,
  REVIEW_OBLIGATION_RULES,
} from "../src/review/manifest.js";

/**
 * W039 — the deterministic review coverage manifest. Review scope is derived
 * from `git status --porcelain=v1 -z --untracked-files=all` output (never an
 * LLM judgment), obligations attach by explicit path rules, and the
 * completion check blocks approvals that leave manifest entries unreviewed.
 */

const execGit = promisify(execFile);

function git(workspace: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: workspace, stdio: ["ignore", "ignore", "ignore"] });
}

function write(workspace: string, path: string, content: string): void {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), content, { flag: "wx" });
}

function tempWorkspace(t: TestContext, prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

test("parseReviewStatus decodes modified, added, deleted, renamed, and untracked records", () => {
  const output = "M  src/a.ts\0A  src/b.ts\0 D src/c.ts\0R  moved.ts\0old.ts\0?? new.ts\0";
  assert.deepEqual(parseReviewStatus(output), [
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "added" },
    { path: "src/c.ts", status: "deleted" },
    { path: "moved.ts", status: "renamed", sourcePath: "old.ts" },
    { path: "new.ts", status: "untracked" },
  ]);
});

test("parseReviewStatus tolerates a branch header record and trailing separators", () => {
  const withBranch = "## feat/x...origin/feat/x\0M  src/a.ts\0\0";
  assert.deepEqual(parseReviewStatus(withBranch), [{ path: "src/a.ts", status: "modified" }]);
  assert.deepEqual(parseReviewStatus(""), []);
});

test("a rename record at the end of the stream degrades fail-safely without a source path", () => {
  assert.deepEqual(parseReviewStatus("R  moved.ts\0"), [{ path: "moved.ts", status: "renamed" }]);
});

test("obligations attach deterministically from the explicit rule table", () => {
  assert.deepEqual(reviewObligationsForPath("src/containment/linux-bwrap.ts"), ["security", "general"]);
  assert.deepEqual(reviewObligationsForPath("src/integrations/credentials.ts"), ["security", "general"]);
  assert.deepEqual(reviewObligationsForPath("src/integrations/mcp-toolbox-guard.ts"), ["security", "general"]);
  assert.deepEqual(reviewObligationsForPath("src/kernel/contracts.ts"), ["authority", "general"]);
  assert.deepEqual(reviewObligationsForPath("src/application/workflow.ts"), ["authority", "general"]);
  assert.deepEqual(reviewObligationsForPath("test/thing.test.ts"), ["tests", "general"]);
  assert.deepEqual(reviewObligationsForPath("docs/HUB_PROTOCOL.md"), ["docs", "general"]);
  assert.deepEqual(reviewObligationsForPath("README.md"), ["docs", "general"]);
  assert.deepEqual(reviewObligationsForPath("src/ui/tui.tsx"), ["general"]);
  // Every rule names its reason — W040 extends this table, it never re-derives scope.
  for (const rule of REVIEW_OBLIGATION_RULES) {
    assert.ok(rule.reason.length > 0);
  }
});

test("deriveReviewCoverageManifest sorts entries and is deterministic across input order", () => {
  const forward = "M  src/b.ts\0?? src/a.ts\0M  src/c.ts\0";
  const reversed = "M  src/c.ts\0?? src/a.ts\0M  src/b.ts\0";
  const left = deriveReviewCoverageManifest({ statusOutput: forward });
  const right = deriveReviewCoverageManifest({ statusOutput: reversed });
  assert.deepEqual(
    left.entries.map((entry) => entry.path),
    ["src/a.ts", "src/b.ts", "src/c.ts"],
  );
  assert.equal(left.digest, right.digest);
  assert.match(left.digest, /^[0-9a-f]{64}$/);
  assert.equal(left.digest, manifestDigest(left.entries));
});

test("reviewCoverageGaps reports unreviewed manifest entries in manifest order", () => {
  const manifest = deriveReviewCoverageManifest({ statusOutput: "M  src/a.ts\0?? src/b.ts\0M  src/c.ts\0" });
  assert.deepEqual(reviewCoverageGaps({ manifest, coveredPaths: ["src/a.ts", "src/b.ts", "src/c.ts"] }), []);
  assert.deepEqual(reviewCoverageGaps({ manifest, coveredPaths: ["  src/a.ts ", "src/b.ts"] }), ["src/c.ts"]);
  // Empty or missing [COVERAGE] content leaves every required entry unreviewed.
  assert.deepEqual(reviewCoverageGaps({ manifest, coveredPaths: [] }), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(reviewCoverageGaps({ manifest, coveredPaths: ["", "   "] }), ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("renderReviewManifestText renders scope entries and the empty case", () => {
  const manifest = deriveReviewCoverageManifest({ statusOutput: "R  dst.ts\0src.ts\0?? u.ts\0" });
  assert.equal(
    renderReviewManifestText(manifest),
    [
      "2 entries in scope:",
      "- dst.ts (from src.ts) - renamed [obligations: general]",
      "- u.ts - untracked [obligations: general]",
    ].join("\n"),
  );
  const empty = deriveReviewCoverageManifest({ statusOutput: "" });
  assert.equal(renderReviewManifestText(empty), "No changed or untracked files are in scope for this review.");
});

test("a large diff derives a complete manifest with stable obligations and exact gaps", () => {
  const modified: string[] = [];
  const untracked: string[] = [];
  for (let index = 0; index < 400; index += 1) {
    modified.push(`M  src/generated/file-${index}.ts`);
    untracked.push(`?? src/generated/untracked-${index}.ts`);
  }
  modified.push("M  src/containment/generated.ts");
  const statusOutput = [...modified, ...untracked].join("\0");
  const manifest = deriveReviewCoverageManifest({ statusOutput });

  assert.equal(manifest.entries.length, 801);
  const containment = manifest.entries.find((entry) => entry.path === "src/containment/generated.ts");
  assert.deepEqual(containment?.obligations, ["security", "general"]);

  const covered = manifest.entries.filter((_, index) => index % 2 === 0).map((entry) => entry.path);
  const gaps = reviewCoverageGaps({ manifest, coveredPaths: covered });
  assert.equal(gaps.length, 400);
  assert.ok(gaps.every((gap) => manifest.entries.some((entry) => entry.path === gap)));

  // Re-derivation is byte-stable for large inputs.
  assert.equal(deriveReviewCoverageManifest({ statusOutput }).digest, manifest.digest);
});

test("the manifest covers a real repository: untracked, renamed, deleted, and security-sensitive files", async (t) => {
  const workspace = tempWorkspace(t, "wf-review-manifest-ws-");
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "manifest@test");
  git(workspace, "config", "user.name", "manifest test");
  const baseline: readonly string[] = [
    "src/kernel/graph.ts",
    "src/containment/linux-bwrap.ts",
    "src/application/workflow.ts",
    "test/thing.test.ts",
    "docs/FEATURES.md",
    "plain.txt",
    "old_name.ts",
    "doomed.txt",
  ];
  for (const path of baseline) {
    write(workspace, path, `baseline ${path}\n`);
  }
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "baseline");

  for (const path of ["src/kernel/graph.ts", "src/containment/linux-bwrap.ts", "docs/FEATURES.md", "plain.txt", "test/thing.test.ts"]) {
    writeFileSync(join(workspace, path), "changed\n", { flag: "a" });
  }
  git(workspace, "mv", "old_name.ts", "new_name.ts");
  git(workspace, "rm", "-q", "doomed.txt");
  write(workspace, "src/new-module.ts", "new\n");
  write(workspace, "docs/untracked-note.md", "note\n");

  const { stdout } = await execGit("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: workspace,
    maxBuffer: 1024 * 1024,
  });
  const manifest = deriveReviewCoverageManifest({ statusOutput: stdout });

  assert.deepEqual(
    manifest.entries.map((entry) => `${entry.status}:${entry.path}`),
    [
      "modified:docs/FEATURES.md",
      "untracked:docs/untracked-note.md",
      "deleted:doomed.txt",
      "renamed:new_name.ts",
      "modified:plain.txt",
      "modified:src/containment/linux-bwrap.ts",
      "modified:src/kernel/graph.ts",
      "untracked:src/new-module.ts",
      "modified:test/thing.test.ts",
    ],
  );
  const renamed = manifest.entries.find((entry) => entry.path === "new_name.ts");
  assert.equal(renamed?.sourcePath, "old_name.ts");

  const obligations = new Map(manifest.entries.map((entry) => [entry.path, entry.obligations]));
  assert.deepEqual(obligations.get("src/containment/linux-bwrap.ts"), ["security", "general"]);
  assert.deepEqual(obligations.get("src/kernel/graph.ts"), ["authority", "general"]);
  assert.deepEqual(obligations.get("test/thing.test.ts"), ["tests", "general"]);
  assert.deepEqual(obligations.get("docs/FEATURES.md"), ["docs", "general"]);
  assert.deepEqual(obligations.get("docs/untracked-note.md"), ["docs", "general"]);
  assert.deepEqual(obligations.get("plain.txt"), ["general"]);
  assert.deepEqual(obligations.get("src/new-module.ts"), ["general"]);

  // The W039 headline: `git diff HEAD` omits untracked files — the manifest
  // does not. Untracked scope must not silently fall out of review.
  const { stdout: diffNames } = await execGit("git", ["diff", "HEAD", "--name-only"], { cwd: workspace, maxBuffer: 1024 * 1024 });
  assert.ok(!diffNames.includes("src/new-module.ts"));
  assert.ok(manifest.entries.some((entry) => entry.path === "src/new-module.ts"));

  const allPaths = manifest.entries.map((entry) => entry.path);
  assert.deepEqual(reviewCoverageGaps({ manifest, coveredPaths: allPaths }), []);
  const partial = allPaths.filter((path) => path !== "docs/untracked-note.md");
  assert.deepEqual(reviewCoverageGaps({ manifest, coveredPaths: partial }), ["docs/untracked-note.md"]);
});
