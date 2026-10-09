/**
 * Hub-side dispatch records and the `validateDispatch(taskId)` evidence-ingest
 * read path (C1 deploy plan §2.c, decision D1/D3).
 *
 * Task 4 built the ENQUEUE seam. This module closes the return leg: when the
 * hub dispatches a job it records what that job DECLARED it would produce
 * (`declaredEvidence`, the guard-corpus fingerprint, the evidence blob path).
 * The worker pod later uploads an evidence blob to
 * `<blobPrefix>/<taskId>.json`; `validateDispatch` fetches it, checks it
 * structurally, and checks the DECLARED evidence is actually covered — the
 * "evidence freshness stays hub-owned; a run that returns without declared
 * evidence does not advance state" discipline (spec §6:126-130).
 *
 * The registry is the denominator: without a hub-held record of what was
 * dispatched, a caller could self-satisfy its own coverage check. The record
 * is written by the hub's own enqueue closure, never supplied by the client.
 *
 * Protocol: REST only, no Azure SDK (the key-vault.ts discipline) — the same
 * shared IMDS/azure-cli Bearer chain (`azure-token.ts`) as the enqueue client.
 * This module is Integrations-layer only: it introduces no kernel types and
 * mutates no task state (it records an observability outcome).
 */

import { AZURE_STORAGE_API_VERSION, AZURE_STORAGE_SCOPE, type AzureJobsHttpFetcher } from "./azure-jobs-dispatch.js";
import { createCachedTokenSource, defaultAzureTokenFetcher, type AccessTokenFetcher } from "./azure-token.js";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ── the worker evidence blob shape (mirrors images/worker/run.mjs, hub-side) ──

/**
 * The evidence blob the worker uploads. This is NOT the dispatch message: the
 * worker writes a RESULT record. The runtime image is built from a Dockerfile
 * (not `npm ci` of this tree), so the pod keeps its own copy; this validator is
 * the hub-side intake and the shapes are pinned to agree by test.
 */
export interface WorkerEvidenceRecord {
  readonly specVersion: 1;
  readonly taskId: string;
  readonly exitCode: number;
  readonly corpusFingerprint: string;
  readonly declaredEvidence: readonly string[];
  readonly model?: { readonly id: string } | undefined;
  readonly branch?: string | undefined;
  readonly prUrl?: string | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

export class WorkerEvidenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerEvidenceError";
  }
}

/**
 * A malformed ingest REQUEST (e.g. an unsafe taskId) — a client fault, distinct
 * from a transport fault. A dedicated class so the route classifies a 400 by
 * type, not by message-string inspection (the `AzureJobMessageError` discipline
 * on the enqueue side).
 */
export class DispatchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRequestError";
  }
}

/** The route's fault classifier for a malformed ingest request. */
export function isDispatchRequestError(error: unknown): error is DispatchRequestError {
  return error instanceof DispatchRequestError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkerEvidenceError(`invalid worker evidence: ${path} must be a non-empty string`);
  }
  return value;
}

/** Structurally validates a returned evidence blob; throws on any mismatch (fail closed). */
export function validateWorkerEvidence(value: unknown): WorkerEvidenceRecord {
  if (!isRecord(value)) throw new WorkerEvidenceError("invalid worker evidence: the record must be an object");
  if (value.specVersion !== 1) {
    throw new WorkerEvidenceError("invalid worker evidence: unsupported or missing specVersion (expected 1)");
  }
  const exitCode = value.exitCode;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
    throw new WorkerEvidenceError("invalid worker evidence: exitCode must be an integer");
  }
  if (!Array.isArray(value.declaredEvidence)) {
    throw new WorkerEvidenceError("invalid worker evidence: declaredEvidence must be an array");
  }
  const declaredEvidence = value.declaredEvidence.map((entry: unknown, index: number) =>
    requireString(entry, `declaredEvidence[${index}]`),
  );
  const record: WorkerEvidenceRecord = {
    specVersion: 1,
    taskId: requireString(value.taskId, "taskId"),
    exitCode,
    corpusFingerprint: requireString(value.corpusFingerprint, "corpusFingerprint"),
    declaredEvidence,
    ...(isRecord(value.model) && typeof value.model.id === "string" ? { model: { id: value.model.id } } : {}),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.prUrl === "string" ? { prUrl: value.prUrl } : {}),
    ...(typeof value.stdout === "string" ? { stdout: value.stdout } : {}),
    ...(typeof value.stderr === "string" ? { stderr: value.stderr } : {}),
  };
  return record;
}

// ── the dispatch record registry (the hub-held denominator) ──────────────────

/** What the hub records when it dispatches a job. */
export interface DispatchRecord {
  readonly taskId: string;
  /** The evidence the run DECLARED it would return (the coverage denominator). */
  readonly declaredEvidence: readonly string[];
  /** The guard-corpus fingerprint the pod must have executed under. */
  readonly corpusFingerprint: string;
  /** `<blobPrefix>/<taskId>.json` — where the worker writes its result. */
  readonly blobPath: string;
  readonly evidenceContainer: string;
  readonly messageId: string;
  readonly dispatchedAt: string;
}

/** The outcome of a `validateDispatch` read (observability; no state transition). */
export type DispatchValidationStatus =
  | "unknown"
  | "missing"
  | "invalid"
  | "incomplete"
  | "stale-corpus"
  | "failed"
  | "covered";

export interface DispatchValidationOutcome {
  readonly taskId: string;
  readonly status: DispatchValidationStatus;
  /** Expected-but-absent evidence names (status "incomplete"). */
  readonly missing?: readonly string[];
  /** The worker's exit code when the blob was read (statuses "failed"/"covered"). */
  readonly exitCode?: number;
  /** A human reason for "invalid"/"stale-corpus". */
  readonly reason?: string;
  readonly branch?: string;
  readonly prUrl?: string;
}

export interface DispatchRecordRegistry {
  /** Records a dispatched job. Later records for the same taskId replace the prior one. */
  record(record: DispatchRecord): void;
  get(taskId: string): DispatchRecord | undefined;
  /** Appends a validation outcome to the bounded outcome journal (observability-only). */
  recordOutcome(outcome: DispatchValidationOutcome): void;
  outcomes(): readonly DispatchValidationOutcome[];
  /** The bounded append journal of dispatch records (most recent last). */
  records(): readonly DispatchRecord[];
}

/** The registry bound: keeps a long-lived hub from growing without limit. Both the lookup map and the two journals are bounded to this size. */
export const DISPATCH_JOURNAL_LIMIT = 64;

export function createDispatchRecordRegistry(): DispatchRecordRegistry {
  const byTask = new Map<string, DispatchRecord>();
  const journal: DispatchRecord[] = [];
  const outcomeJournal: DispatchValidationOutcome[] = [];
  return {
    record(record) {
      // Re-insert so a re-recorded task moves to the freshest position (Map
      // iteration is insertion-order), matching the journal's oldest-first
      // eviction.
      byTask.delete(record.taskId);
      byTask.set(record.taskId, record);
      // Bound the primary lookup too: an evicted task validates as "unknown"
      // (honest), matching the journal's oldest-first eviction.
      while (byTask.size > DISPATCH_JOURNAL_LIMIT) {
        const oldest = byTask.keys().next().value;
        if (oldest === undefined) break;
        byTask.delete(oldest);
      }
      journal.push(record);
      while (journal.length > DISPATCH_JOURNAL_LIMIT) journal.shift();
    },
    get(taskId) {
      return byTask.get(taskId);
    },
    recordOutcome(outcome) {
      outcomeJournal.push(outcome);
      while (outcomeJournal.length > DISPATCH_JOURNAL_LIMIT) outcomeJournal.shift();
    },
    outcomes() {
      return [...outcomeJournal];
    },
    records() {
      return [...journal];
    },
  };
}

// ── the ingest read path ─────────────────────────────────────────────────────

/** The composed closure the hub route calls (reads + checks, records an outcome). */
export type ValidateDispatchFn = (taskId: string) => Promise<DispatchValidationOutcome>;

export interface AzureJobsIngestOptions {
  readonly registry: DispatchRecordRegistry;
  readonly accountUrl: string;
  readonly fetcher?: AzureJobsHttpFetcher;
  readonly getToken?: AccessTokenFetcher;
  readonly timeoutMs?: number;
}

/**
 * Builds the ingest closure. `validate(taskId)`:
 *   1. resolves the hub-held record; an unknown id is `unknown` (fail closed,
 *      never a fabricated pass — the denominator is the hub's own record);
 *   2. fetches the evidence blob; a 404 is `missing`;
 *   3. structurally validates the blob (`invalid` on any mismatch);
 *   4. checks the DECLARED evidence is covered (`incomplete` names the gap);
 *   5. checks the corpus fingerprint matches the dispatch (`stale-corpus`);
 *   6. reports a nonzero exit as `failed`; otherwise `covered`.
 * A transport fault (not a 404) THROWS, so the route reports a 5xx rather than
 * a fabricated outcome. Every resolved outcome is appended to the journal.
 */
export function createAzureJobsIngest(options: AzureJobsIngestOptions): ValidateDispatchFn {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const token = createCachedTokenSource(AZURE_STORAGE_SCOPE, options.getToken ?? defaultAzureTokenFetcher(process.env, fetcher));

  async function read(taskId: string): Promise<DispatchValidationOutcome> {
    if (!SAFE_SEGMENT.test(taskId)) {
      throw new DispatchRequestError(`invalid dispatch validation request: taskId must be a safe path segment`);
    }
    const record = options.registry.get(taskId);
    if (record === undefined) return { taskId, status: "unknown" };

    const path = record.blobPath.split("/").map(encodeURIComponent).join("/");
    // Read from the container the record itself names, not a separately
    // configured one: the record is the single source of truth for where this
    // job's evidence lives (the enqueue path already bound the two).
    const url = `${options.accountUrl}/${encodeURIComponent(record.evidenceContainer)}/${path}`;
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await token()}`,
        "x-ms-version": AZURE_STORAGE_API_VERSION,
        "x-ms-date": new Date().toUTCString(),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { taskId, status: "missing" };
    if (!response.ok) {
      // Any other non-2xx is a transport/server fault: throw so the route 5xx's.
      throw new Error(`azure job dispatch: the evidence blob answered ${response.status}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch (error) {
      return { taskId, status: "invalid", reason: `not JSON (${error instanceof Error ? error.message : String(error)})` };
    }
    let evidence: WorkerEvidenceRecord;
    try {
      evidence = validateWorkerEvidence(parsed);
    } catch (error) {
      return { taskId, status: "invalid", reason: error instanceof Error ? error.message : String(error) };
    }
    // The returned blob must belong to the record we asked about: a blob for
    // task A cannot satisfy a validate for task B (the registry keys by id).
    if (evidence.taskId !== record.taskId) {
      return {
        taskId,
        status: "invalid",
        reason: `evidence taskId '${evidence.taskId}' does not match the requested '${record.taskId}'`,
      };
    }

    const returned = new Set(evidence.declaredEvidence);
    const missing = record.declaredEvidence.filter((name) => !returned.has(name));
    if (missing.length > 0) return { taskId, status: "incomplete", missing };
    if (evidence.corpusFingerprint !== record.corpusFingerprint) {
      return {
        taskId,
        status: "stale-corpus",
        reason: `corpus fingerprint ${evidence.corpusFingerprint} does not match the dispatched ${record.corpusFingerprint}`,
      };
    }
    if (evidence.exitCode !== 0) return { taskId, status: "failed", exitCode: evidence.exitCode };
    return {
      taskId,
      status: "covered",
      exitCode: 0,
      ...(evidence.branch === undefined ? {} : { branch: evidence.branch }),
      ...(evidence.prUrl === undefined ? {} : { prUrl: evidence.prUrl }),
    };
  }

  return async (taskId: string): Promise<DispatchValidationOutcome> => {
    // Every RESOLVED outcome is journaled (observability-only). A transport
    // fault throws from `read` and is never journaled — it is not an outcome.
    const outcome = await read(taskId);
    options.registry.recordOutcome(outcome);
    return outcome;
  };
}

/**
 * Wraps the enqueue closure so every SUCCESSFUL dispatch is recorded before the
 * wrapper returns to its caller (a failed enqueue records nothing). The raw
 * message is validated here to extract the declared evidence / corpus / blob
 * path; a malformed message throws `AzureJobMessageError` (unchanged), so the
 * enqueue path's 400 classification is preserved. `now` is injectable for
 * deterministic tests.
 */
export function createRecordingEnqueue(options: {
  readonly registry: DispatchRecordRegistry;
  readonly enqueue: (message: unknown) => Promise<{ readonly taskId: string; readonly messageId: string; readonly viaBlobRef: boolean }>;
  readonly validate: (message: unknown) => {
    readonly taskId: string;
    readonly task: { readonly declaredEvidence: readonly string[] };
    readonly mcp: { readonly corpusFingerprint: string };
    readonly artifacts: { readonly blobPrefix: string; readonly evidenceContainer: string };
  };
  readonly now?: (() => string) | undefined;
}): (message: unknown) => Promise<{ readonly taskId: string; readonly messageId: string; readonly viaBlobRef: boolean }> {
  const now = options.now ?? (() => new Date().toISOString());
  return async (message) => {
    const validated = options.validate(message);
    const result = await options.enqueue(message);
    options.registry.record({
      taskId: validated.taskId,
      declaredEvidence: [...validated.task.declaredEvidence],
      corpusFingerprint: validated.mcp.corpusFingerprint,
      blobPath: `${validated.artifacts.blobPrefix}/${validated.taskId}.json`,
      evidenceContainer: validated.artifacts.evidenceContainer,
      messageId: result.messageId,
      dispatchedAt: now(),
    });
    return result;
  };
}
