import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type Freshness = "fresh" | "stale" | "unknown";
export type CurrentSubject =
  | { kind: "fingerprint"; algorithm: string; version: string; scope: string; value: string }
  | { kind: "ci_revision"; provider: string; repository: string; revision: string };
export type LocalTestSource = { kind: "local_test"; capability: "test-intelligence-mcp/run_tests"; testIds: string[] };
export type CiRunSource = { kind: "ci_run"; capability: "ci-intelligence-mcp/list_ci_runs"; provider: "github"; repository: string; runId: string };
export type VerificationSource = LocalTestSource | CiRunSource;
export interface LocalTestResult {
  outcome: "completed" | "timed_out" | "cancelled"; exitCode: number | null;
  passed: number; failed: number; skipped: number; todo: number;
  testsTruncated: boolean; failuresTruncated: boolean; diagnosticsTruncated: boolean;
}
export interface AuthorityLocalTestResult {
  outcome: LocalTestResult["outcome"]; exitCode: number | null;
  tests: Array<{ status: "passed" | "failed" | "skipped" | "todo" }>;
  testsTruncated: boolean; failures: unknown[]; failuresTruncated: boolean; diagnosticsTruncated: boolean;
}
export interface AuthorityCiRun {
  id: string; revision: string; state: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | "action_required" | "unknown";
}
export interface CiRunResult {
  revision: string; state: AuthorityCiRun["state"]; conclusion?: AuthorityCiRun["conclusion"]; listingTruncated: boolean;
}
export interface VerificationAuthorities {
  runTests(input: { workspaceRoot: string; testIds: string[]; timeoutMs?: number }, signal?: AbortSignal): Promise<AuthorityLocalTestResult>;
  listCiRuns(input: { revision?: string; limit: number }, signal?: AbortSignal): Promise<{ runs: AuthorityCiRun[]; truncated: boolean }>;
  ciRepository(): string | undefined;
}
export type RecordVerificationInput =
  | { workspaceRoot: string; request: { kind: "local_test"; testIds: string[]; timeoutMs?: number } }
  | { workspaceRoot: string; request: { kind: "ci_run"; runId: string; revision?: string } };
export interface VerificationObservation {
  id: string; evidenceClass: "observation"; source: VerificationSource; result: LocalTestResult | CiRunResult;
  subject: { kind: "local_test_execution"; workspace: string; contentSubject: "unavailable" } | { kind: "ci_revision"; provider: string; repository: string; revision: string };
  recordedAt: number; freshness: Freshness; provenance: { workspace: string };
}
export interface ListVerificationsInput { workspaceRoot: string; currentSubject?: CurrentSubject; limit?: number }

interface StoredObservation extends Omit<VerificationObservation, "freshness" | "provenance"> {}
interface StoreDocument { version: 1; workspace: string; observations: StoredObservation[] }

const MAX_OBSERVATIONS = 500;
const MAX_STORE_BYTES = 5 * 1024 * 1024;
const SECRET_PATTERNS = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, /\bsk-[A-Za-z0-9_-]{20,}\b/, /\bAKIA[0-9A-Z]{16}\b/];

function abortIfNeeded(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("Verification accountability operation cancelled."); }
function boundedText(value: string, name: string, max = 300): string {
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > max || /[\0\r\n]/.test(trimmed)) throw new Error(`${name} is invalid or exceeds its limit.`);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(trimmed))) throw new Error("Verification provenance appears to contain a secret and was not stored.");
  return trimmed;
}
async function canonicalWorkspace(workspaceRoot: string): Promise<string> {
  if (!isAbsolute(workspaceRoot) || /[\0\r\n]/.test(workspaceRoot)) throw new Error("Workspace root must be an absolute directory.");
  try { const workspace = await realpath(workspaceRoot); if (!(await stat(workspace)).isDirectory()) throw new Error(); return workspace; }
  catch { throw new Error("Workspace root must be an existing directory."); }
}
function validCount(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000; }
function validLocalResult(result: LocalTestResult): boolean {
  const counts = [result.passed, result.failed, result.skipped, result.todo];
  const interruptedValid = result.outcome === "completed" || (counts.every((count) => count === 0) && !result.testsTruncated && !result.failuresTruncated && !result.diagnosticsTruncated);
  return ["completed", "timed_out", "cancelled"].includes(result.outcome) && (result.exitCode === null || Number.isInteger(result.exitCode)) && counts.every(validCount) && counts.reduce((sum, count) => sum + count, 0) <= 1000 && [result.testsTruncated, result.failuresTruncated, result.diagnosticsTruncated].every((value) => typeof value === "boolean") && (!result.failuresTruncated || result.diagnosticsTruncated) && interruptedValid;
}
function validCiResult(result: CiRunResult): boolean {
  const conclusionValid = result.state === "completed"
    ? result.conclusion !== undefined && ["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown"].includes(result.conclusion)
    : result.conclusion === undefined;
  return /^[0-9a-fA-F]{40}$/.test(result.revision) && ["queued", "in_progress", "completed"].includes(result.state) && conclusionValid && typeof result.listingTruncated === "boolean";
}
function normalizeRevision(value: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(value)) throw new Error("CI revision is invalid.");
  return value.toLowerCase();
}
function validateCurrentSubject(subject: CurrentSubject): CurrentSubject {
  if (subject.kind === "ci_revision") return { kind: "ci_revision", provider: boundedText(subject.provider, "CI provider", 100), repository: boundedText(subject.repository, "CI repository", 300), revision: normalizeRevision(subject.revision) };
  return { kind: "fingerprint", algorithm: boundedText(subject.algorithm, "Fingerprint algorithm", 100), version: boundedText(subject.version, "Fingerprint version", 100), scope: boundedText(subject.scope, "Fingerprint scope", 200), value: boundedText(subject.value, "Fingerprint value", 300) };
}
function observationFreshness(observation: StoredObservation, current?: CurrentSubject): Freshness {
  if (!current || observation.subject.kind !== "ci_revision" || current.kind !== "ci_revision") return "unknown";
  if (observation.subject.provider !== current.provider || observation.subject.repository !== current.repository) return "unknown";
  return observation.subject.revision === current.revision ? "fresh" : "stale";
}
function validTestIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 500 && value.every((id) => {
    if (typeof id !== "string" || !id.startsWith("node:")) return false;
    const path = id.slice("node:".length);
    const segments = path.split("/");
    return /\.(?:test|spec)\.(?:js|cjs|mjs|ts|cts|mts)$/.test(path) && !path.startsWith("/") && !path.includes("\\") && !segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git" || segment === "node_modules") && id === boundedText(id, "Test ID", 1000);
  });
}
function validStoredObservation(value: unknown, workspace: string): value is StoredObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredObservation>;
  if (typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id) || item.evidenceClass !== "observation" || !Number.isSafeInteger(item.recordedAt) || (item.recordedAt ?? -1) < 0 || !item.source || !item.subject || !item.result) return false;
  try {
    if (item.source.kind === "local_test") {
      return item.source.capability === "test-intelligence-mcp/run_tests" && validTestIds(item.source.testIds) && item.subject.kind === "local_test_execution" && item.subject.workspace === workspace && item.subject.contentSubject === "unavailable" && validLocalResult(item.result as LocalTestResult);
    }
    if (item.source.kind !== "ci_run" || item.source.capability !== "ci-intelligence-mcp/list_ci_runs" || item.source.provider !== "github" || item.subject.kind !== "ci_revision") return false;
    const repository = boundedText(item.source.repository, "CI repository", 300); const runId = boundedText(item.source.runId, "CI run ID", 200); const result = item.result as CiRunResult;
    return repository === item.source.repository && /^github:[1-9]\d*$/.test(runId) && item.subject.provider === "github" && item.subject.repository === repository && item.subject.revision === result.revision && validCiResult(result);
  } catch { return false; }
}

export class VerificationStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly dataRoot: string, private readonly authorities: VerificationAuthorities) {}
  private pathFor(workspace: string): string { return join(this.dataRoot, `${createHash("sha256").update(workspace).digest("hex")}.json`); }
  private async load(workspace: string): Promise<StoreDocument> {
    try {
      const path = this.pathFor(workspace); if ((await stat(path)).size > MAX_STORE_BYTES) throw new Error("Verification store exceeds its size limit.");
      const parsed = JSON.parse(await readFile(path, "utf8")) as StoreDocument;
      if (parsed.version !== 1 || parsed.workspace !== workspace || !Array.isArray(parsed.observations) || parsed.observations.length > MAX_OBSERVATIONS || !parsed.observations.every((item) => validStoredObservation(item, workspace))) throw new Error();
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspace, observations: [] };
      if (error instanceof Error && error.message.includes("size limit")) throw error;
      throw new Error("Verification accountability store is malformed or unreadable.");
    }
  }
  private async persist(workspace: string, document: StoreDocument, signal?: AbortSignal): Promise<void> {
    const serialized = `${JSON.stringify(document)}\n`; if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("Verification store exceeds its size limit.");
    abortIfNeeded(signal); await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const path = this.pathFor(workspace); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" }); abortIfNeeded(signal); await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  private async mutate<T>(workspace: string, operation: (document: StoreDocument) => T, signal?: AbortSignal): Promise<T> {
    let result!: T; const previous = this.writes.get(workspace) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => { abortIfNeeded(signal); const document = await this.load(workspace); result = operation(document); await this.persist(workspace, document, signal); });
    this.writes.set(workspace, write); try { await write; return result; } finally { if (this.writes.get(workspace) === write) this.writes.delete(workspace); }
  }
  async recordVerification(input: RecordVerificationInput, signal?: AbortSignal): Promise<VerificationObservation> {
    abortIfNeeded(signal); const workspace = await canonicalWorkspace(input.workspaceRoot);
    let source: VerificationSource; let result: LocalTestResult | CiRunResult; let subject: StoredObservation["subject"];
    if (input.request.kind === "local_test") {
      if (!validTestIds(input.request.testIds)) throw new Error("Local test IDs are invalid.");
      if (input.request.timeoutMs !== undefined && (!Number.isInteger(input.request.timeoutMs) || input.request.timeoutMs < 100 || input.request.timeoutMs > 120_000)) throw new Error("Local test timeout is invalid.");
      const observed = await this.authorities.runTests({ workspaceRoot: workspace, testIds: [...input.request.testIds], ...(input.request.timeoutMs === undefined ? {} : { timeoutMs: input.request.timeoutMs }) }, signal);
      const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
      for (const test of observed.tests) counts[test.status] += 1;
      result = { outcome: observed.outcome, exitCode: observed.exitCode, ...counts, testsTruncated: observed.testsTruncated, failuresTruncated: observed.failuresTruncated, diagnosticsTruncated: observed.diagnosticsTruncated };
      if (!validLocalResult(result)) throw new Error("Test Intelligence returned invalid verification evidence.");
      source = { kind: "local_test", capability: "test-intelligence-mcp/run_tests", testIds: [...input.request.testIds] };
      subject = { kind: "local_test_execution", workspace, contentSubject: "unavailable" };
    } else {
      const repository = this.authorities.ciRepository();
      if (!repository) throw new Error("CI verification authority is not configured.");
      const normalizedRepository = boundedText(repository, "CI repository", 300); const runId = boundedText(input.request.runId, "CI run ID", 200);
      if (!/^github:[1-9]\d*$/.test(runId)) throw new Error("CI run ID is invalid.");
      const revision = input.request.revision === undefined ? undefined : normalizeRevision(input.request.revision);
      const observed = await this.authorities.listCiRuns({ ...(revision === undefined ? {} : { revision }), limit: 100 }, signal);
      const run = observed.runs.find((candidate) => candidate.id === runId);
      if (!run) throw new Error(observed.truncated ? "CI run was not present in the bounded authority result." : "CI run was not found by the authority.");
      const runRevision = normalizeRevision(run.revision);
      if (revision !== undefined && runRevision !== revision) throw new Error("CI authority returned a mismatched revision.");
      result = { revision: runRevision, state: run.state, ...(run.conclusion === undefined ? {} : { conclusion: run.conclusion }), listingTruncated: observed.truncated };
      if (!validCiResult(result)) throw new Error("CI Intelligence returned invalid verification evidence.");
      source = { kind: "ci_run", capability: "ci-intelligence-mcp/list_ci_runs", provider: "github", repository: normalizedRepository, runId };
      subject = { kind: "ci_revision", provider: "github", repository: normalizedRepository, revision: runRevision };
    }
    return this.mutate(workspace, (document) => {
      if (document.observations.length >= MAX_OBSERVATIONS) throw new Error("Verification record limit reached.");
      const stored: StoredObservation = { id: randomUUID(), evidenceClass: "observation", source, result, subject, recordedAt: Date.now() };
      document.observations.push(stored); return { ...stored, freshness: "unknown", provenance: { workspace } };
    }, signal);
  }
  async listVerifications(input: ListVerificationsInput, signal?: AbortSignal): Promise<{ observations: VerificationObservation[]; truncated: boolean }> {
    abortIfNeeded(signal); const workspace = await canonicalWorkspace(input.workspaceRoot); const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Verification list limit must be 1-50.");
    const current = input.currentSubject ? validateCurrentSubject(input.currentSubject) : undefined; const document = await this.load(workspace);
    const ordered = [...document.observations].sort((a, b) => b.recordedAt - a.recordedAt || a.id.localeCompare(b.id));
    return { observations: ordered.slice(0, limit).map((item) => ({ ...item, freshness: observationFreshness(item, current), provenance: { workspace } })), truncated: ordered.length > limit };
  }
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VERIFICATION_ACCOUNTABILITY_DATA_DIR) return resolve(env.VERIFICATION_ACCOUNTABILITY_DATA_DIR);
  if (env.XDG_DATA_HOME) return join(resolve(env.XDG_DATA_HOME), "verification-accountability-mcp");
  if (!env.HOME) throw new Error("HOME is required when no verification accountability data directory is configured.");
  return join(resolve(env.HOME), ".local", "share", "verification-accountability-mcp");
}
