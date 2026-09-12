export interface DiscoverTestsQuery {
  workspaceRoot: string;
  limit: number;
}

export interface TestDescriptor {
  id: string;
  file: string;
  label: string;
  runner: string;
}

export interface DiscoverTestsResult {
  tests: readonly TestDescriptor[];
  truncated: boolean;
}

export interface FindRelevantTestsQuery {
  workspaceRoot: string;
  file: string;
  limit: number;
}

export interface RelevantTestDescriptor extends TestDescriptor {
  relevance: "exact_file" | "matching_stem" | "same_project";
}

export interface FindRelevantTestsResult {
  tests: readonly RelevantTestDescriptor[];
  truncated: boolean;
}

export interface RunTestsQuery {
  workspaceRoot: string;
  testIds: readonly string[];
  timeoutMs: number;
}

export interface TestExecution {
  name: string;
  nameTruncated: boolean;
  file: string;
  status: "passed" | "failed" | "skipped" | "todo";
  durationMs: number;
}

export interface TestFailure {
  name: string;
  nameTruncated: boolean;
  file: string;
  message: string;
  truncated: boolean;
}

export interface RunTestsResult {
  outcome: "completed" | "timed_out" | "cancelled";
  exitCode: number | null;
  tests: readonly TestExecution[];
  testsTruncated: boolean;
  failures: readonly TestFailure[];
  failuresTruncated: boolean;
  diagnosticsTruncated: boolean;
}

export interface TestAdapter {
  discoverTests(query: DiscoverTestsQuery, signal?: AbortSignal): Promise<DiscoverTestsResult>;
  findRelevantTests(query: FindRelevantTestsQuery, signal?: AbortSignal): Promise<FindRelevantTestsResult>;
  runTests(query: RunTestsQuery, signal?: AbortSignal): Promise<RunTestsResult>;
}
