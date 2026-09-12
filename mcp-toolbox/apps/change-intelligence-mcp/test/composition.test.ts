import assert from "node:assert/strict";
import { test } from "node:test";

import { assessLocalChange, type GitStatusPort, type TestRelevancePort } from "../src/assessment.ts";

const emptyLocalDiff: GitStatusPort["localDiff"] = async () => ({ files: [], truncated: false, evidenceTruncated: false });

test("composes deterministic path facts and structural test evidence with provenance", async () => {
  const git: GitStatusPort = {
    localDiff: emptyLocalDiff,
    workingTreeStatus: async () => ({
      entries: [
        { path: "src/z.ts", staged: "none", unstaged: "modified" },
        { path: "src/a.ts", staged: "added", unstaged: "none" },
      ],
      truncated: false,
    }),
  };
  const tests: TestRelevancePort = {
    findRelevantTests: async ({ file }) => ({
      tests: [{ id: `node:${file}.test.ts`, file: `${file}.test.ts`, relevance: "matching_stem" }],
      truncated: false,
    }),
  };

  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests });

  assert.deepEqual(result, {
    paths: [
      {
        path: "src/a.ts",
        staged: "added",
        unstaged: "none",
        source: { capability: "git.working_tree_status", id: "src/a.ts" },
        relevantTests: [{ id: "node:src/a.ts.test.ts", file: "src/a.ts.test.ts", relevance: "matching_stem", source: { capability: "test.find_relevant_tests", id: "node:src/a.ts.test.ts" } }],
        testsTruncated: false,
        affectedSymbols: null,
        symbolsTruncated: null,
      },
      {
        path: "src/z.ts",
        staged: "none",
        unstaged: "modified",
        source: { capability: "git.working_tree_status", id: "src/z.ts" },
        relevantTests: [{ id: "node:src/z.ts.test.ts", file: "src/z.ts.test.ts", relevance: "matching_stem", source: { capability: "test.find_relevant_tests", id: "node:src/z.ts.test.ts" } }],
        testsTruncated: false,
        affectedSymbols: null,
        symbolsTruncated: null,
      },
    ],
    pathsTruncated: false,
    incomplete: false,
    testRun: null,
    verificationGaps: [
      { kind: "relevant_tests_not_run", testId: "node:src/a.ts.test.ts", file: "src/a.ts.test.ts", sources: [{ capability: "git.working_tree_status", id: "src/a.ts" }, { capability: "test.find_relevant_tests", id: "node:src/a.ts.test.ts" }] },
      { kind: "relevant_tests_not_run", testId: "node:src/z.ts.test.ts", file: "src/z.ts.test.ts", sources: [{ capability: "git.working_tree_status", id: "src/z.ts" }, { capability: "test.find_relevant_tests", id: "node:src/z.ts.test.ts" }] },
    ],
    recommendedChecks: [
      { kind: "run_test", testId: "node:src/a.ts.test.ts", file: "src/a.ts.test.ts", sources: [{ capability: "git.working_tree_status", id: "src/a.ts" }, { capability: "test.find_relevant_tests", id: "node:src/a.ts.test.ts" }] },
      { kind: "run_test", testId: "node:src/z.ts.test.ts", file: "src/z.ts.test.ts", sources: [{ capability: "git.working_tree_status", id: "src/z.ts" }, { capability: "test.find_relevant_tests", id: "node:src/z.ts.test.ts" }] },
    ],
    recommendationsTruncated: false,
  });
});

test("derives affected symbols and consumers only from intersecting Git and Code evidence", async () => {
  const git: GitStatusPort = {
    workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }], truncated: false }),
    localDiff: async ({ scope }) => scope === "unstaged"
      ? { files: [{ path: "src/a.ts", change: "modified", binary: false, patch: "@@ -1,3 +1,3 @@\n export const untouched = 1;\n-export function changed() { return 1; }\n+export function changed() { return 2; }\n export const other = 3;", patchTruncated: false }], truncated: false, evidenceTruncated: false }
      : { files: [], truncated: false, evidenceTruncated: false },
  };
  const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
  const code = {
    documentSymbols: async () => ({
      symbols: [
        { name: "untouched", kind: "const", file: "src/a.ts", line: 1, column: 14, endLine: 1, endColumn: 23 },
        { name: "changed", kind: "function", file: "src/a.ts", line: 2, column: 17, endLine: 2, endColumn: 24 },
      ],
      truncated: false,
    }),
    findReferences: async () => ({
      locations: [
        { file: "src/a.ts", line: 2, column: 17, endLine: 2, endColumn: 24 },
        { file: "src/use.ts", line: 4, column: 1, endLine: 4, endColumn: 8 },
      ],
      truncated: false,
    }),
  };

  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests, code });

  assert.deepEqual(result.paths[0]?.affectedSymbols, [{
    name: "changed", kind: "function", file: "src/a.ts", line: 2, column: 17, endLine: 2, endColumn: 24,
    sources: [
      { capability: "git.working_tree_status", id: "src/a.ts" },
      { capability: "git.local_diff", id: "unstaged:src/a.ts" },
      { capability: "code.document_symbols", id: "src/a.ts:2:17:changed" },
    ],
    consumers: [{ file: "src/use.ts", line: 4, column: 1, endLine: 4, endColumn: 8, source: { capability: "code.find_references", id: "src/use.ts:4:1:4:8" } }],
    consumersTruncated: false,
  }]);
  assert.equal(result.paths[0]?.symbolsTruncated, false);
  assert.equal(result.incomplete, false);
});

test("keeps semantic correlation unknown when Git cannot map current lines", async () => {
  for (const file of [
    { path: "deleted.ts", change: "deleted" as const, patch: "@@ -1 +0,0 @@\n-export const gone = 1;" },
    { path: "renamed.ts", change: "renamed" as const, patch: "@@ -1 +1 @@\n-export const oldName = 1;\n+export const newName = 1;" },
    { path: "binary.ts", change: "modified" as const, binary: true, patch: undefined },
    { path: "truncated.ts", change: "modified" as const, patch: "@@ -1 +1 @@\n-a\n+b", patchTruncated: true },
  ]) {
    let symbolCalls = 0;
    const git: GitStatusPort = {
      workingTreeStatus: async () => ({ entries: [{ path: file.path, staged: "modified", unstaged: "none" }], truncated: false }),
      localDiff: async ({ scope }) => scope === "staged" ? {
        files: [{ path: file.path, change: file.change, binary: file.binary ?? false, patch: file.patch, patchTruncated: file.patchTruncated ?? false }],
        truncated: false, evidenceTruncated: file.patchTruncated ?? false,
      } : { files: [], truncated: false, evidenceTruncated: false },
    };
    const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
    const code = {
      documentSymbols: async () => { symbolCalls += 1; return { symbols: [], truncated: false }; },
      findReferences: async () => ({ locations: [], truncated: false }),
    };
    const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests, code });
    assert.equal(symbolCalls, 0, file.path);
    assert.equal(result.paths[0]?.affectedSymbols, null, file.path);
  }
});

test("does not request TypeScript semantic evidence for unsupported changed files", async () => {
  let symbolCalls = 0;
  const git: GitStatusPort = {
    workingTreeStatus: async () => ({ entries: [{ path: "package.json", staged: "none", unstaged: "modified" }], truncated: false }),
    localDiff: async ({ scope }) => scope === "unstaged"
      ? { files: [{ path: "package.json", change: "modified", binary: false, patch: "@@ -1 +1 @@\n-{\"name\":\"old\"}\n+{\"name\":\"new\"}", patchTruncated: false }], truncated: false, evidenceTruncated: false }
      : { files: [], truncated: false, evidenceTruncated: false },
  };
  const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
  const code = {
    documentSymbols: async () => { symbolCalls += 1; throw new Error("unsupported file"); },
    findReferences: async () => ({ locations: [], truncated: false }),
  };

  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests, code });

  assert.equal(symbolCalls, 0);
  assert.equal(result.paths[0]?.affectedSymbols, null);
  assert.equal(result.paths[0]?.symbolsTruncated, null);
});

test("does not infer semantic evidence for untracked or mixed-scope changes", async () => {
  for (const scenario of ["untracked", "mixed"] as const) {
    let symbolCalls = 0;
    const git: GitStatusPort = {
      workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: scenario === "untracked" ? "none" : "modified", unstaged: scenario === "untracked" ? "untracked" : "modified" }], truncated: false }),
      localDiff: async ({ scope }) => scenario === "mixed"
        ? { files: [{ path: "src/a.ts", change: "modified", binary: false, patch: "@@ -1 +1 @@\n-a\n+b", patchTruncated: false }], truncated: false, evidenceTruncated: false }
        : { files: [], truncated: false, evidenceTruncated: false },
    };
    const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
    const code = {
      documentSymbols: async () => { symbolCalls += 1; return { symbols: [], truncated: false }; },
      findReferences: async () => ({ locations: [], truncated: false }),
    };
    const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests, code });
    assert.equal(symbolCalls, 0, scenario);
    assert.equal(result.paths[0]?.affectedSymbols, null, scenario);
  }
});

test("correlates staged signature edits and added declarations using current hunk lines", async () => {
  for (const scenario of [
    { name: "signature", state: "modified" as const, patch: "@@ -1,2 +1,2 @@\n-export function changed(value: string) {\n+export function changed(value: number) {\n   return value;\n", symbol: { name: "changed", kind: "function", file: "src/a.ts", line: 1, column: 17, endLine: 3, endColumn: 1 } },
    { name: "add", state: "added" as const, patch: "@@ -0,0 +1,2 @@\n+export const added = 1;\n+export const other = 2;", symbol: { name: "added", kind: "const", file: "src/a.ts", line: 1, column: 14, endLine: 1, endColumn: 19 } },
  ]) {
    const git: GitStatusPort = {
      workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: scenario.state, unstaged: "none" }], truncated: false }),
      localDiff: async ({ scope }) => scope === "staged"
        ? { files: [{ path: "src/a.ts", change: scenario.state, binary: false, patch: scenario.patch, patchTruncated: false }], truncated: false, evidenceTruncated: false }
        : { files: [], truncated: false, evidenceTruncated: false },
    };
    const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
    const code = { documentSymbols: async () => ({ symbols: [scenario.symbol], truncated: false }), findReferences: async () => ({ locations: [], truncated: false }) };
    const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests, code });
    assert.equal(result.paths[0]?.affectedSymbols?.[0]?.name, scenario.symbol.name, scenario.name);
    assert.deepEqual(result.paths[0]?.affectedSymbols?.[0]?.sources, [
      { capability: "git.working_tree_status", id: "src/a.ts" },
      { capability: "git.local_diff", id: "staged:src/a.ts" },
      { capability: "code.document_symbols", id: `src/a.ts:${scenario.symbol.line}:${scenario.symbol.column}:${scenario.symbol.name}` },
    ], scenario.name);
  }
});

test("pure deletions and unchanged lines across multiple hunks do not become affected symbols", async () => {
  let referenceCalls = 0;
  const git: GitStatusPort = {
    workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }], truncated: false }),
    localDiff: async ({ scope }) => scope === "unstaged"
      ? { files: [{ path: "src/a.ts", change: "modified", binary: false, patch: "@@ -1,2 +1 @@\n-export const deleted = 1;\n export const kept = 2;\n@@ -9 +8 @@\n-export const alsoDeleted = 3;", patchTruncated: false }], truncated: false, evidenceTruncated: false }
      : { files: [], truncated: false, evidenceTruncated: false },
  };
  const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
  const code = { documentSymbols: async () => ({ symbols: [{ name: "kept", kind: "const", file: "src/a.ts", line: 1, column: 14, endLine: 1, endColumn: 18 }], truncated: false }), findReferences: async () => { referenceCalls += 1; return { locations: [], truncated: false }; } };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests, code });
  assert.equal(result.paths[0]?.affectedSymbols, null);
  assert.equal(referenceCalls, 0);
});

test("status suppresses mixed-scope correlation even when the opposite diff is truncated away", async () => {
  let symbolCalls = 0;
  const git: GitStatusPort = {
    workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "modified", unstaged: "modified" }], truncated: false }),
    localDiff: async ({ scope }) => scope === "staged"
      ? { files: [{ path: "src/a.ts", change: "modified", binary: false, patch: "@@ -1 +1 @@\n-a\n+b", patchTruncated: false }], truncated: false, evidenceTruncated: false }
      : { files: [], truncated: true, evidenceTruncated: true },
  };
  const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
  const code = { documentSymbols: async () => { symbolCalls += 1; return { symbols: [], truncated: false }; }, findReferences: async () => ({ locations: [], truncated: false }) };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests, code });
  assert.equal(symbolCalls, 0);
  assert.equal(result.paths[0]?.affectedSymbols, null);
  assert.equal(result.incomplete, true);
});

test("bounds semantic work and marks aggregate consumer truncation", async () => {
  let referenceCalls = 0;
  const git: GitStatusPort = {
    workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }], truncated: false }),
    localDiff: async ({ scope }) => scope === "unstaged"
      ? { files: [{ path: "src/a.ts", change: "modified", binary: false, patch: "@@ -1,2 +1,2 @@\n-a\n-b\n+export const a = 1;\n+export const b = 2;", patchTruncated: false }], truncated: false, evidenceTruncated: false }
      : { files: [], truncated: false, evidenceTruncated: false },
  };
  const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
  const code = {
    documentSymbols: async () => ({ symbols: [
      { name: "a", kind: "const", file: "src/a.ts", line: 1, column: 14, endLine: 1, endColumn: 15 },
      { name: "b", kind: "const", file: "src/a.ts", line: 2, column: 14, endLine: 2, endColumn: 15 },
    ], truncated: false }),
    findReferences: async () => { referenceCalls += 1; return { locations: [
      { file: "src/use-a.ts", line: 1, column: 1, endLine: 1, endColumn: 2 },
      { file: "src/use-b.ts", line: 1, column: 1, endLine: 1, endColumn: 2 },
    ], truncated: false }; },
  };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5, symbolLimit: 2, referenceLimit: 1 }, { git, tests, code });
  assert.equal(referenceCalls, 1);
  assert.equal(result.paths[0]?.affectedSymbols?.[0]?.consumers?.length, 1);
  assert.equal(result.paths[0]?.affectedSymbols?.[0]?.consumersTruncated, true);
  assert.equal(result.paths[0]?.affectedSymbols?.[1]?.consumers, null);
  assert.equal(result.paths[0]?.symbolsTruncated, true);
  assert.equal(result.incomplete, true);
});

test("synthesizes bounded verification gaps without treating relevance as coverage", async () => {
  const git: GitStatusPort = { workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }, { path: "src/b.ts", staged: "none", unstaged: "modified" }], truncated: false }), localDiff: emptyLocalDiff };
  const tests: TestRelevancePort = {
    findRelevantTests: async ({ file }) => file === "src/a.ts" ? { tests: [{ id: "node:a.test.ts", file: "a.test.ts", relevance: "matching_stem" }], truncated: false } : { tests: [], truncated: false },
    runTests: async () => { throw new Error("must not execute without opt-in"); },
  };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5, recommendationLimit: 2 }, { git, tests });
  assert.deepEqual(result.verificationGaps.map((gap) => gap.kind), ["no_relevant_tests", "relevant_tests_not_run"]);
  assert.deepEqual(result.recommendedChecks.map((check) => check.kind), ["review_test_gap", "run_test"]);
  assert.equal(result.testRun, null);
  assert.equal(result.recommendationsTruncated, false);
});

test("keeps observed failing test results distinct from recommendations", async () => {
  const git: GitStatusPort = { workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }], truncated: false }), localDiff: emptyLocalDiff };
  const tests: TestRelevancePort = {
    findRelevantTests: async () => ({ tests: [{ id: "node:a.test.ts", file: "a.test.ts", relevance: "matching_stem" }], truncated: false }),
    runTests: async () => ({ outcome: "completed", exitCode: 1, tests: [{ name: "fails", nameTruncated: false, file: "a.test.ts", status: "failed", durationMs: 1 }], testsTruncated: false, failures: [{ name: "fails", nameTruncated: false, file: "a.test.ts", message: "expected 1", truncated: false }], failuresTruncated: false, diagnosticsTruncated: false }),
  };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5, runRelevantTests: true }, { git, tests });
  assert.equal(result.testRun?.tests[0]?.status, "failed");
  assert.equal(result.verificationGaps[0]?.kind, "failed_test");
  assert.equal(result.recommendedChecks[0]?.kind, "run_test");
  assert.equal(result.recommendedChecks[0]?.testId, "node:a.test.ts");
  assert.deepEqual(result.recommendedChecks[0]?.sources, [
    { capability: "git.working_tree_status", id: "src/a.ts" },
    { capability: "test.find_relevant_tests", id: "node:a.test.ts" },
    { capability: "test.run_tests", id: "a.test.ts:fails" },
  ]);
});

test("keeps omitted and interrupted relevant tests visibly unverified", async () => {
  const git: GitStatusPort = { workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }], truncated: false }), localDiff: emptyLocalDiff };
  const tests: TestRelevancePort = {
    findRelevantTests: async () => ({ tests: [
      { id: "node:a.test.ts", file: "a.test.ts", relevance: "matching_stem" },
      { id: "node:b.test.ts", file: "b.test.ts", relevance: "same_project" },
    ], truncated: false }),
    runTests: async () => ({ outcome: "timed_out", exitCode: null, tests: [], testsTruncated: false, failures: [], failuresTruncated: false, diagnosticsTruncated: false }),
  };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5, runRelevantTests: true, testExecutionLimit: 1, recommendationLimit: 3 }, { git, tests });
  assert.deepEqual(result.testRun?.requestedTestIds, ["node:a.test.ts"]);
  assert.equal(result.verificationGaps.some((gap) => gap.kind === "incomplete_evidence"), true);
  assert.equal(result.verificationGaps.some((gap) => gap.testId === "node:b.test.ts" && gap.kind === "relevant_tests_not_run"), true);
  assert.deepEqual(result.recommendedChecks.filter((check) => check.kind === "run_test").map((check) => check.testId), ["node:a.test.ts", "node:b.test.ts"]);
  assert.equal(result.incomplete, true);
});

test("propagates truncated verification evidence and bounds recommendations", async () => {
  const git: GitStatusPort = { workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }, { path: "src/b.ts", staged: "none", unstaged: "modified" }], truncated: false }), localDiff: emptyLocalDiff };
  const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: true }), runTests: async () => { throw new Error("not called"); } };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 1, recommendationLimit: 1 }, { git, tests });
  assert.equal(result.incomplete, true);
  assert.equal(result.recommendedChecks.length, 0);
  assert.equal(result.recommendationsTruncated, false);
  assert.equal(result.verificationGaps.filter((gap) => gap.kind === "incomplete_evidence").length, 2);
  assert.equal(result.verificationGaps.some((gap) => gap.kind === "no_relevant_tests"), false);
});

test("marks recommendation truncation only when a recommendation is actually omitted", async () => {
  const git: GitStatusPort = { workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }, { path: "src/b.ts", staged: "none", unstaged: "modified" }], truncated: false }), localDiff: emptyLocalDiff };
  const tests: TestRelevancePort = { findRelevantTests: async () => ({ tests: [], truncated: false }) };
  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 1, recommendationLimit: 1 }, { git, tests });
  assert.equal(result.recommendedChecks.length, 1);
  assert.equal(result.recommendationsTruncated, true);
});

test("propagates status truncation and does not claim test evidence for deleted paths", async () => {
  let relevanceCalls = 0;
  const git: GitStatusPort = {
    localDiff: emptyLocalDiff,
    workingTreeStatus: async () => ({ entries: [{ path: "gone.ts", staged: "deleted", unstaged: "none" }], truncated: true }),
  };
  const tests: TestRelevancePort = {
    findRelevantTests: async () => {
      relevanceCalls += 1;
      return { tests: [], truncated: false };
    },
  };

  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests });

  assert.equal(relevanceCalls, 0);
  assert.equal(result.pathsTruncated, true);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.paths[0]?.relevantTests, null);
  assert.equal(result.paths[0]?.testsTruncated, null);
});

test("propagates relevance truncation per changed path", async () => {
  const git: GitStatusPort = {
    localDiff: emptyLocalDiff,
    workingTreeStatus: async () => ({ entries: [{ path: "src/a.ts", staged: "none", unstaged: "modified" }], truncated: false }),
  };
  const tests: TestRelevancePort = {
    findRelevantTests: async () => ({ tests: [], truncated: true }),
  };

  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests });
  assert.equal(result.paths[0]?.testsTruncated, true);
  assert.equal(result.incomplete, true);
});

test("enriches a staged deletion when Git also reports a recreated current path", async () => {
  let relevanceCalls = 0;
  const git: GitStatusPort = {
    localDiff: emptyLocalDiff,
    workingTreeStatus: async () => ({
      entries: [
        { path: "recreated.ts", staged: "deleted", unstaged: "none" },
        { path: "recreated.ts", staged: "none", unstaged: "untracked" },
      ],
      truncated: false,
    }),
  };
  const tests: TestRelevancePort = {
    findRelevantTests: async () => {
      relevanceCalls += 1;
      return { tests: [], truncated: false };
    },
  };

  const result = await assessLocalChange({ workspaceRoot: "/work", pathLimit: 20, testLimit: 5 }, { git, tests });

  assert.equal(relevanceCalls, 2);
  assert.deepEqual(result.paths.map((path) => path.relevantTests), [[], []]);
  assert.deepEqual(result.paths.map((path) => path.testsTruncated), [false, false]);
});
