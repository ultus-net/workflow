export type ChangeState = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unmerged" | "untracked" | "none";
export type TestRelevance = "exact_file" | "matching_stem" | "same_project";

export interface GitStatusPort {
  workingTreeStatus(query: { workspaceRoot: string; limit: number }, signal?: AbortSignal): Promise<{
    entries: Array<{ path: string; originalPath?: string; staged: ChangeState; unstaged: ChangeState; conflict?: string }>;
    truncated: boolean;
  }>;
  localDiff(query: { workspaceRoot: string; scope: "staged" | "unstaged"; limit: number }, signal?: AbortSignal): Promise<{
    files: Array<{ path: string; originalPath?: string; change: Exclude<ChangeState, "untracked" | "none">; binary: boolean; patch?: string; patchTruncated: boolean }>;
    truncated: boolean;
    evidenceTruncated: boolean;
  }>;
}

export interface TestRelevancePort {
  findRelevantTests(query: { workspaceRoot: string; file: string; limit: number }, signal?: AbortSignal): Promise<{
    tests: Array<{ id: string; file: string; relevance: TestRelevance }>;
    truncated: boolean;
  }>;
  runTests?(query: { workspaceRoot: string; testIds: string[]; timeoutMs: number }, signal?: AbortSignal): Promise<TestRunResult>;
}

interface TestRunResult {
  outcome: "completed" | "timed_out" | "cancelled";
  exitCode: number | null;
  tests: Array<{ name: string; nameTruncated: boolean; file: string; status: "passed" | "failed" | "skipped" | "todo"; durationMs: number }>;
  testsTruncated: boolean;
  failures: Array<{ name: string; nameTruncated: boolean; file: string; message: string; truncated: boolean }>;
  failuresTruncated: boolean;
  diagnosticsTruncated: boolean;
}

export interface CodeSemanticPort {
  documentSymbols(query: { workspaceRoot: string; file: string; limit: number }, signal?: AbortSignal): Promise<{
    symbols: SourceSymbol[];
    truncated: boolean;
  }>;
  findReferences(query: { workspaceRoot: string; file: string; line: number; column: number; limit: number }, signal?: AbortSignal): Promise<{
    locations: SourceLocation[];
    truncated: boolean;
  }>;
}

interface SourceLocation { file: string; line: number; column: number; endLine: number; endColumn: number }
interface SourceSymbol extends SourceLocation { name: string; kind: string }

export interface AssessmentQuery {
  workspaceRoot: string;
  pathLimit: number;
  testLimit: number;
  symbolLimit?: number;
  referenceLimit?: number;
  recommendationLimit?: number;
  testExecutionLimit?: number;
  runRelevantTests?: boolean;
  testTimeoutMs?: number;
}

export async function assessLocalChange(
  query: AssessmentQuery,
  ports: { git: GitStatusPort; tests: TestRelevancePort; code?: CodeSemanticPort },
  signal?: AbortSignal,
) {
  const status = await ports.git.workingTreeStatus({ workspaceRoot: query.workspaceRoot, limit: query.pathLimit }, signal);
  const paths = [];
  const relevantTestSources = new Map<string, { file: string; sources: Array<{ capability: string; id: string }> }>();
  const inspectablePaths = new Set(status.entries.filter((entry) => !isDeletion(entry)).map((entry) => entry.path));
  const semantic = ports.code
    ? await collectSemanticEvidence(query, status.entries, ports.git, ports.code, signal)
    : { evidence: new Map<string, SemanticEvidence>(), incomplete: false };

  for (const entry of [...status.entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const source = { capability: "git.working_tree_status" as const, id: entry.path };
    const base = { ...entry, source };
    if (isDeletion(entry) && !inspectablePaths.has(entry.path)) {
      paths.push({ ...base, relevantTests: null, testsTruncated: null, affectedSymbols: null, symbolsTruncated: null });
      continue;
    }

    const relevance = await ports.tests.findRelevantTests(
      { workspaceRoot: query.workspaceRoot, file: entry.path, limit: query.testLimit },
      signal,
    );
    for (const test of relevance.tests) {
      const evidence = relevantTestSources.get(test.id) ?? { file: test.file, sources: [] };
      evidence.sources.push({ capability: "git.working_tree_status", id: entry.path }, { capability: "test.find_relevant_tests", id: test.id });
      relevantTestSources.set(test.id, evidence);
    }
    paths.push({
      ...base,
      relevantTests: relevance.tests.map((test) => ({
        ...test,
        source: { capability: "test.find_relevant_tests" as const, id: test.id },
      })),
      testsTruncated: relevance.truncated,
      affectedSymbols: semantic.evidence.get(entry.path)?.symbols ?? null,
      symbolsTruncated: semantic.evidence.get(entry.path)?.truncated ?? null,
    });
  }

  const recommendationLimit = query.recommendationLimit ?? 20;
  const candidateTests = [...relevantTestSources].sort(([left], [right]) => left.localeCompare(right));
  const selectedTests = candidateTests.slice(0, query.testExecutionLimit ?? 20);
  const omittedTests = candidateTests.slice(selectedTests.length);
  const testRun = query.runRelevantTests && selectedTests.length > 0
    ? await requireTestRun(ports.tests, { workspaceRoot: query.workspaceRoot, testIds: selectedTests.map(([id]) => id), timeoutMs: query.testTimeoutMs ?? 30_000 }, signal)
    : null;
  const verification = synthesizeVerification(paths, selectedTests, omittedTests, testRun, recommendationLimit);

  return {
    paths,
    pathsTruncated: status.truncated,
    incomplete: status.truncated || semantic.incomplete || paths.some((path) => path.testsTruncated === true || path.symbolsTruncated === true)
      || Boolean(testRun && (testRun.outcome !== "completed" || testRun.testsTruncated || testRun.failuresTruncated || testRun.diagnosticsTruncated)),
    ...verification,
  };
}

async function requireTestRun(port: TestRelevancePort, query: { workspaceRoot: string; testIds: string[]; timeoutMs: number }, signal?: AbortSignal): Promise<TestRunResult> {
  if (!port.runTests) throw new Error("required capability test.run_tests failed");
  return port.runTests(query, signal);
}

function synthesizeVerification(
  paths: Array<{ path: string; relevantTests: Array<{ id: string; file: string; source: { capability: "test.find_relevant_tests"; id: string } }> | null; testsTruncated: boolean | null }>,
  selectedTests: Array<[string, { file: string; sources: Array<{ capability: string; id: string }> }]>,
  omittedTests: Array<[string, { file: string; sources: Array<{ capability: string; id: string }> }]>,
  testRun: TestRunResult | null,
  limit: number,
) {
  const verificationGaps: Array<{ kind: "no_relevant_tests" | "relevant_tests_not_run" | "failed_test" | "incomplete_evidence"; path?: string; testId?: string; file?: string; sources: Array<{ capability: string; id: string }> }> = [];
  const recommendedChecks: Array<{ kind: "run_test" | "review_test_gap"; testId?: string; file?: string; sources: Array<{ capability: string; id: string }> }> = [];
  let recommendationsTruncated = false;
  const pushRecommendation = (value: (typeof recommendedChecks)[number]) => {
    if (recommendedChecks.length < limit) recommendedChecks.push(value);
    else recommendationsTruncated = true;
  };
  for (const path of paths) {
    if (path.testsTruncated) verificationGaps.push({ kind: "incomplete_evidence", path: path.path, sources: [{ capability: "test.find_relevant_tests", id: path.path }] });
    if (path.testsTruncated === false && path.relevantTests?.length === 0) {
      verificationGaps.push({ kind: "no_relevant_tests", path: path.path, sources: [{ capability: "git.working_tree_status", id: path.path }, { capability: "test.find_relevant_tests", id: path.path }] });
      pushRecommendation({ kind: "review_test_gap", file: path.path, sources: [{ capability: "git.working_tree_status", id: path.path }, { capability: "test.find_relevant_tests", id: path.path }] });
    }
  }
  if (!testRun) {
    for (const [testId, test] of selectedTests) {
      verificationGaps.push({ kind: "relevant_tests_not_run", testId, file: test.file, sources: test.sources });
      pushRecommendation({ kind: "run_test", testId, file: test.file, sources: test.sources });
    }
  } else {
    for (const failure of testRun.failures) {
      verificationGaps.push({ kind: "failed_test", file: failure.file, sources: [{ capability: "test.run_tests", id: `${failure.file}:${failure.name}` }] });
      const selected = selectedTests.find(([, test]) => test.file === failure.file);
      pushRecommendation({ kind: "run_test", testId: selected?.[0], file: failure.file, sources: [...(selected?.[1].sources ?? []), { capability: "test.run_tests", id: `${failure.file}:${failure.name}` }] });
    }
    if (testRun.testsTruncated || testRun.failuresTruncated || testRun.diagnosticsTruncated || testRun.outcome !== "completed") {
      verificationGaps.push({ kind: "incomplete_evidence", sources: [{ capability: "test.run_tests", id: "execution" }] });
      if (testRun.outcome !== "completed") {
        for (const [testId, test] of selectedTests) pushRecommendation({ kind: "run_test", testId, file: test.file, sources: [...test.sources, { capability: "test.run_tests", id: "execution" }] });
      }
    }
  }
  for (const [testId, test] of omittedTests) {
    verificationGaps.push({ kind: "relevant_tests_not_run", testId, file: test.file, sources: test.sources });
    pushRecommendation({ kind: "run_test", testId, file: test.file, sources: test.sources });
  }
  return {
    testRun: testRun ? { ...testRun, requestedTestIds: selectedTests.map(([id]) => id), source: { capability: "test.run_tests", id: "execution" } } : null,
    verificationGaps,
    recommendedChecks,
    recommendationsTruncated,
  };
}

interface SemanticEvidence {
  symbols: Array<SourceSymbol & { sources: Array<{ capability: string; id: string }>; consumers: Array<SourceLocation & { source: { capability: string; id: string } }> | null; consumersTruncated: boolean | null }>;
  truncated: boolean;
  incomplete: boolean;
}

async function collectSemanticEvidence(
  query: AssessmentQuery,
  statusEntries: Array<{ path: string; staged: ChangeState; unstaged: ChangeState; conflict?: string }>,
  git: GitStatusPort,
  code: CodeSemanticPort,
  signal?: AbortSignal,
): Promise<{ evidence: Map<string, SemanticEvidence>; incomplete: boolean }> {
  const limit = query.pathLimit;
  const [staged, unstaged] = await Promise.all([
    git.localDiff({ workspaceRoot: query.workspaceRoot, scope: "staged", limit }, signal),
    git.localDiff({ workspaceRoot: query.workspaceRoot, scope: "unstaged", limit }, signal),
  ]);
  const candidates = new Map<string, Array<{ scope: "staged" | "unstaged"; patch: string }>>();
  const eligibleScope = new Map<string, "staged" | "unstaged">();
  for (const entry of statusEntries) {
    if (entry.conflict || entry.staged === "untracked" || entry.unstaged === "untracked") continue;
    const scopes = [entry.staged !== "none" ? "staged" : null, entry.unstaged !== "none" ? "unstaged" : null].filter((scope): scope is "staged" | "unstaged" => scope !== null);
    if (scopes.length === 1 && !eligibleScope.has(entry.path)) eligibleScope.set(entry.path, scopes[0]);
    else eligibleScope.delete(entry.path);
  }
  for (const [scope, result] of [["staged", staged], ["unstaged", unstaged]] as const) {
    for (const file of result.files) {
      if (eligibleScope.get(file.path) !== scope) continue;
      if (file.change === "deleted" || file.change === "renamed" || file.binary || file.patchTruncated || !file.patch) continue;
      if (!/\.(?:cts|mts|tsx?|d\.ts)$/i.test(file.path)) continue;
      const existing = candidates.get(file.path) ?? [];
      existing.push({ scope, patch: file.patch });
      candidates.set(file.path, existing);
    }
  }

  const evidence = new Map<string, SemanticEvidence>();
  let remainingSymbols = query.symbolLimit ?? 20;
  let remainingConsumers = query.referenceLimit ?? 100;
  let aggregateTruncated = false;
  for (const [file, diffs] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
    const changedLines = new Set(diffs.flatMap(({ patch }) => parseChangedCurrentLines(patch)));
    if (changedLines.size === 0) continue;
    const symbols = await code.documentSymbols({ workspaceRoot: query.workspaceRoot, file, limit: Math.min(query.symbolLimit ?? 20, remainingSymbols + 1) }, signal);
    const affected = [];
    for (const symbol of symbols.symbols) {
      if (![...changedLines].some((line) => line >= symbol.line && line <= symbol.endLine)) continue;
      if (remainingSymbols === 0) {
        aggregateTruncated = true;
        break;
      }
      remainingSymbols -= 1;
      if (remainingConsumers === 0) {
        aggregateTruncated = true;
        affected.push({
          ...symbol,
          sources: [
            { capability: "git.working_tree_status", id: file },
            ...diffs.map(({ scope }) => ({ capability: "git.local_diff", id: `${scope}:${file}` })),
            { capability: "code.document_symbols", id: `${file}:${symbol.line}:${symbol.column}:${symbol.name}` },
          ],
          consumers: null,
          consumersTruncated: null,
        });
        continue;
      }
      const references = await code.findReferences({ workspaceRoot: query.workspaceRoot, file, line: symbol.line, column: symbol.column, limit: Math.min(500, remainingConsumers + 1) }, signal);
      const consumersTruncated = references.truncated || references.locations.filter((location) => !(location.file === symbol.file && location.line === symbol.line && location.column === symbol.column)).length > remainingConsumers;
      const consumers = references.locations
        .filter((location) => !(location.file === symbol.file && location.line === symbol.line && location.column === symbol.column))
        .slice(0, remainingConsumers)
        .map((location) => ({ ...location, source: { capability: "code.find_references", id: locationId(location) } }));
      remainingConsumers -= consumers.length;
      if (consumersTruncated) aggregateTruncated = true;
      affected.push({
        ...symbol,
        sources: [
          { capability: "git.working_tree_status", id: file },
          ...diffs.map(({ scope }) => ({ capability: "git.local_diff", id: `${scope}:${file}` })),
          { capability: "code.document_symbols", id: `${file}:${symbol.line}:${symbol.column}:${symbol.name}` },
        ],
        consumers,
        consumersTruncated,
      });
    }
    evidence.set(file, { symbols: affected, truncated: symbols.truncated || aggregateTruncated, incomplete: symbols.truncated || aggregateTruncated || affected.some((symbol) => symbol.consumersTruncated === true || symbol.consumers === null) });
  }
  return {
    evidence,
    incomplete: staged.truncated || staged.evidenceTruncated || unstaged.truncated || unstaged.evidenceTruncated || aggregateTruncated || [...evidence.values()].some((item) => item.incomplete),
  };
}

function parseChangedCurrentLines(patch: string): number[] {
  const lines = new Set<number>();
  let currentLine: number | undefined;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }
    if (currentLine === undefined || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      lines.add(currentLine);
      currentLine += 1;
    } else if (line.startsWith(" ")) {
      currentLine += 1;
    } else if (!line.startsWith("-")) {
      currentLine = undefined;
    }
  }
  return [...lines];
}

function locationId(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.column}:${location.endLine}:${location.endColumn}`;
}

function isDeletion(entry: { staged: ChangeState; unstaged: ChangeState }): boolean {
  return entry.staged === "deleted" || entry.unstaged === "deleted";
}
