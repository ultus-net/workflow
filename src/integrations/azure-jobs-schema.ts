/**
 * The Azure Container Apps job dispatch message schema (the LESS-0061
 * "schema is the spec" seam; C1 deploy plan `docs/ledger/control-plane-c1-deploy-plan.md`
 * §2.c, spec `docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
 * §3:76-80 / §9:209-212).
 *
 * One message = one job execution. The hub enqueues it; a worker pod pulls it
 * and verifies the same shape before any work. Validation is fail-closed and
 * STRUCTURAL: an unknown `specVersion`, an absent or empty `declaredEvidence`
 * list, or any missing/mistyped field refuses — never best-effort coercion.
 * The function returns a freshly constructed typed object, never the parsed
 * input, so a hostile client cannot smuggle extra fields past the seam.
 *
 * This module is pure (no IO, no Azure SDK): it is the shared contract between
 * the hub-side enqueue client (`azure-jobs-dispatch.ts`) and the worker pod's
 * intake. It carries secret REFERENCES (Key Vault names) only — never secret
 * VALUES; the pod materializes them in memory.
 */

export const AZURE_JOB_SPEC_VERSION = 1 as const;

/**
 * The structural-validation failure type. A dedicated class (NOT a bare
 * `TypeError`) is essential: a Node fetch transport failure is itself a
 * `TypeError`, so the hub route must distinguish "the message is malformed"
 * (a client fault → 400) from "the network died" (a server fault → 5xx). The
 * route catches THIS class only.
 */
export class AzureJobMessageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AzureJobMessageError";
  }
}

/** The route's fault classifier: a structural validation failure, never a transport TypeError. */
export function isAzureJobMessageError(error: unknown): error is AzureJobMessageError {
  return error instanceof AzureJobMessageError;
}

// A safe path/segment charset: alphanumeric start, then alphanumerics, dot,
// underscore, dash. It forbids "/" and "."/".." segments — an unconstrained
// taskId or prefix would let a hostile message traverse the blob namespace
// (`new URL("https://acct/../../c/x")` normalizes the `..` away).
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH_SEGMENTS = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// Reject WHOLE `.` / `..` path segments (what WHATWG URL normalizes away),
// without over-rejecting a name that merely contains dots (`v1..2`).
function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/** A git checkout target: the clone URL and the ref to check out. */
export interface AzureJobRepoRef {
  readonly url: string;
  readonly ref: string;
}

/**
 * The permission posture a run declares. v1 accepts `advisory` only: a pod
 * cannot be `enforced` (the whole point of the delegated container boundary is
 * that the pod, not an in-process backend, is the wall), and upgrading the
 * claim is gated on the P2 model-key probe (plan task 8; spec §6:126-128). A
 * declared `enforced` is refused by name, never silently downgraded.
 */
export type AzureJobPermissionPosture = "advisory";

export interface AzureJobTask {
  readonly message: string;
  /** Non-empty: a run with no declared evidence never dispatches and its return never advances state. */
  readonly declaredEvidence: readonly string[];
  readonly budgetSeconds: number;
  readonly permissionPosture: AzureJobPermissionPosture;
}

/**
 * The MCP servers the run class needs plus the guard-corpus fingerprint the
 * pod verifies before any work (spec §11:293-298). The fingerprint is an
 * opaque token generated at image build (task 5); the schema only requires a
 * non-empty string.
 */
export interface AzureJobMcp {
  readonly manifest: readonly string[];
  readonly corpusFingerprint: string;
}

export interface AzureJobArtifacts {
  readonly evidenceContainer: string;
  readonly blobPrefix: string;
}

export interface AzureJobMessage {
  readonly specVersion: typeof AZURE_JOB_SPEC_VERSION;
  readonly taskId: string;
  readonly repo: AzureJobRepoRef;
  /** Instance-facing Key Vault ref NAME for the git-push credential; the value stays in Key Vault. */
  readonly gitPush: { readonly secretRef: string };
  /** Instance-facing Key Vault ref NAME for the model credential; the value stays in Key Vault. */
  readonly model: { readonly id: string; readonly secretRef: string };
  readonly task: AzureJobTask;
  readonly mcp: AzureJobMcp;
  readonly artifacts: AzureJobArtifacts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AzureJobMessageError(`invalid azure job message: ${path} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string, options: { readonly allowEmpty: boolean }): string[] {
  if (!Array.isArray(value)) throw new AzureJobMessageError(`invalid azure job message: ${path} must be an array`);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    out.push(requireString(value[index], `${path}[${index}]`));
  }
  if (!options.allowEmpty && out.length === 0) {
    throw new AzureJobMessageError(`invalid azure job message: ${path} must not be empty (a run declares its expected evidence)`);
  }
  return out;
}

/**
 * Structurally validates a candidate dispatch message and returns a freshly
 * constructed typed copy. Throws an `AzureJobMessageError` (a dedicated class,
 * deliberately NOT a bare `TypeError`) naming the offending path on any
 * mismatch — fail-closed, so the caller never sees a partially valid object and
 * a transport `TypeError` is never misread as a message fault.
 */
export function validateAzureJobMessage(value: unknown): AzureJobMessage {
  if (!isRecord(value)) throw new AzureJobMessageError("invalid azure job message: the message must be an object");
  if (value.specVersion !== AZURE_JOB_SPEC_VERSION) {
    throw new AzureJobMessageError(
      `invalid azure job message: unsupported or missing specVersion (expected ${AZURE_JOB_SPEC_VERSION})`,
    );
  }
  const taskId = requireString(value.taskId, "taskId");
  if (!SAFE_SEGMENT.test(taskId)) {
    throw new AzureJobMessageError(
      "invalid azure job message: taskId must be a safe path segment (alphanumerics, dot, underscore, dash)",
    );
  }

  if (!isRecord(value.repo)) throw new AzureJobMessageError("invalid azure job message: repo must be an object");
  const repoUrl = requireString(value.repo.url, "repo.url");
  if (!/^https:\/\/[^\s]+$/.test(repoUrl)) {
    throw new AzureJobMessageError("invalid azure job message: repo.url must be an https clone URL");
  }
  const repo: AzureJobRepoRef = { url: repoUrl, ref: requireString(value.repo.ref, "repo.ref") };

  if (!isRecord(value.gitPush)) throw new AzureJobMessageError("invalid azure job message: gitPush must be an object");
  const gitPush = { secretRef: requireString(value.gitPush.secretRef, "gitPush.secretRef") };

  if (!isRecord(value.model)) throw new AzureJobMessageError("invalid azure job message: model must be an object");
  const model = {
    id: requireString(value.model.id, "model.id"),
    secretRef: requireString(value.model.secretRef, "model.secretRef"),
  };

  if (!isRecord(value.task)) throw new AzureJobMessageError("invalid azure job message: task must be an object");
  const message = requireString(value.task.message, "task.message");
  const declaredEvidence = requireStringArray(value.task.declaredEvidence, "task.declaredEvidence", { allowEmpty: false });
  const budgetSeconds = value.task.budgetSeconds;
  if (typeof budgetSeconds !== "number" || !Number.isInteger(budgetSeconds) || budgetSeconds <= 0) {
    throw new AzureJobMessageError("invalid azure job message: task.budgetSeconds must be a positive integer");
  }
  const declaredPosture = value.task.permissionPosture;
  if (declaredPosture === "enforced") {
    throw new AzureJobMessageError(
      "invalid azure job message: task.permissionPosture \"enforced\" is refused for specVersion 1 " +
        "(the pod-enforced claim is gated on the P2 model-key probe; plan task 8)",
    );
  }
  if (declaredPosture !== "advisory") {
    throw new AzureJobMessageError("invalid azure job message: task.permissionPosture must be \"advisory\"");
  }
  const task: AzureJobTask = {
    message,
    declaredEvidence,
    budgetSeconds,
    permissionPosture: "advisory",
  };

  if (!isRecord(value.mcp)) throw new AzureJobMessageError("invalid azure job message: mcp must be an object");
  const mcp: AzureJobMcp = {
    manifest: requireStringArray(value.mcp.manifest, "mcp.manifest", { allowEmpty: true }),
    corpusFingerprint: requireString(value.mcp.corpusFingerprint, "mcp.corpusFingerprint"),
  };

  if (!isRecord(value.artifacts)) throw new AzureJobMessageError("invalid azure job message: artifacts must be an object");
  const evidenceContainer = requireString(value.artifacts.evidenceContainer, "artifacts.evidenceContainer");
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(evidenceContainer)) {
    throw new AzureJobMessageError("invalid azure job message: artifacts.evidenceContainer must be a valid container name");
  }
  const blobPrefix = requireString(value.artifacts.blobPrefix, "artifacts.blobPrefix");
  if (!SAFE_PATH_SEGMENTS.test(blobPrefix) || hasDotSegment(blobPrefix)) {
    throw new AzureJobMessageError(
      "invalid azure job message: artifacts.blobPrefix must be a safe blob path (no leading/trailing slash, no \".\"/\"..\" segments)",
    );
  }
  const artifacts: AzureJobArtifacts = { evidenceContainer, blobPrefix };

  return { specVersion: AZURE_JOB_SPEC_VERSION, taskId, repo, gitPush, model, task, mcp, artifacts };
}

/** Serializes a validated message to its canonical JSON wire form. */
export function serializeAzureJobMessage(message: AzureJobMessage): string {
  return JSON.stringify(message);
}

/** Parses + validates a wire message (used by the worker pod's intake and the inbox tests). */
export function parseAzureJobMessage(json: string): AzureJobMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new AzureJobMessageError(
      `invalid azure job message: not JSON (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  return validateAzureJobMessage(parsed);
}

/**
 * The oversized-body envelope: when a message exceeds the queue's size limit,
 * the hub uploads the full message to a blob and enqueues this small
 * reference. The pod fetches the blob and validates the full message. Two
 * shapes, one version tag — the pod's intake distinguishes them by the
 * presence of `bodyRef`.
 */
export interface AzureJobRefEnvelope {
  readonly specVersion: typeof AZURE_JOB_SPEC_VERSION;
  readonly taskId: string;
  readonly bodyRef: { readonly container: string; readonly blob: string };
}

/** Structurally validates a blob-ref envelope and returns a fresh typed copy. */
export function validateAzureJobRefEnvelope(value: unknown): AzureJobRefEnvelope {
  if (!isRecord(value)) throw new AzureJobMessageError("invalid azure job envelope: the envelope must be an object");
  if (value.specVersion !== AZURE_JOB_SPEC_VERSION) {
    throw new AzureJobMessageError(
      `invalid azure job envelope: unsupported or missing specVersion (expected ${AZURE_JOB_SPEC_VERSION})`,
    );
  }
  if (!isRecord(value.bodyRef)) throw new AzureJobMessageError("invalid azure job envelope: bodyRef must be an object");
  return {
    specVersion: AZURE_JOB_SPEC_VERSION,
    taskId: requireString(value.taskId, "taskId"),
    bodyRef: {
      container: requireString(value.bodyRef.container, "bodyRef.container"),
      blob: requireString(value.bodyRef.blob, "bodyRef.blob"),
    },
  };
}
