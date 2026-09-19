import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * W054 startup attestation for durable agent-facing state.
 *
 * Persistent state (project memory today; task artifacts, tasklists,
 * scheduled-agent state, skills, and continuity checkpoints as their
 * collectors land) is reloaded into model context every session, so an
 * injection that lands in it is replayed each start. This is a deterministic,
 * read-only validation pass run before the first model turn: it flags records
 * whose provenance stamp is missing or forged (unexpected writer / untrusted
 * origin surface) and content that matches a known canary string. It is
 * advisory observability — it validates structure and provenance, never
 * truth, and never mutates durable state or blocks a tool call.
 */

export const DURABLE_WRITER_AUTHORITIES = ["operator", "agent", "external-evidence"] as const;
export type DurableWriterAuthority = (typeof DURABLE_WRITER_AUTHORITIES)[number];

export const DURABLE_STATE_SOURCES = [
  "project-memory",
  "task-artifact",
  "tasklist",
  "scheduled-agent-state",
  "skill",
  "continuity-checkpoint",
] as const;
export type DurableStateSource = (typeof DURABLE_STATE_SOURCES)[number];

/**
 * Normalized view of one durable-state item. Stamp fields are optional on
 * purpose: a legacy or forged record with no stamp is exactly what
 * attestation must flag, so it cannot be rejected before inspection.
 */
export interface DurableStateRecord {
  readonly source: DurableStateSource;
  readonly id: string;
  readonly content: string;
  readonly writer?: string;
  readonly authority?: DurableWriterAuthority;
  readonly originSurface?: string;
  readonly stampedAt?: number;
}

export type AttestationFindingKind =
  | "missing-stamp"
  | "unexpected-writer"
  | "untrusted-origin"
  | "canary-hit"
  | "unreadable-store";

export interface AttestationFinding {
  readonly kind: AttestationFindingKind;
  readonly source: DurableStateSource;
  readonly recordId: string;
  readonly detail: string;
}

export interface AttestationPolicy {
  readonly trustedWriters: readonly string[];
  readonly trustedOrigins: readonly string[];
  readonly canaries: readonly string[];
}

export interface DurableStateAttestation {
  readonly checked: number;
  readonly findings: readonly AttestationFinding[];
  readonly flagged: boolean;
  readonly storePresent: boolean;
}

/**
 * Stable canary for investigation surfaces and tests: content carrying it is
 * detectable when it reappears in any attested durable state. Operators may
 * add their own with WORKFLOW_DURABLE_STATE_CANARIES (comma-separated).
 */
export const DEFAULT_DURABLE_STATE_CANARY = "WORKFLOW-CANARY-7f3a9c1d-memory-poisoning";

export function defaultAttestationPolicy(env: NodeJS.ProcessEnv = process.env): AttestationPolicy {
  const extra = (env.WORKFLOW_DURABLE_STATE_CANARIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return {
    trustedWriters: ["workflow-compaction-bridge", "workflow-hub", "workflow-cli", "operator"],
    trustedOrigins: ["workflow:cline-runtime", "workflow:hub", "workflow:cli"],
    canaries: [DEFAULT_DURABLE_STATE_CANARY, ...extra],
  };
}

export function isDurableWriterAuthority(value: unknown): value is DurableWriterAuthority {
  return typeof value === "string" && (DURABLE_WRITER_AUTHORITIES as readonly string[]).includes(value);
}

function isCleanIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value);
}

function isStampTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Pure rule engine: classify already-normalized durable-state records. */
export function attestDurableState(
  records: readonly DurableStateRecord[],
  policy: AttestationPolicy,
): { readonly checked: number; readonly findings: readonly AttestationFinding[] } {
  const findings: AttestationFinding[] = [];
  for (const record of records) {
    const writer = record.writer;
    const originSurface = record.originSurface;
    if (isCleanIdentity(writer) && isDurableWriterAuthority(record.authority) && isCleanIdentity(originSurface) && isStampTime(record.stampedAt)) {
      if (!policy.trustedWriters.includes(writer)) {
        findings.push({
          kind: "unexpected-writer", source: record.source, recordId: record.id,
          detail: "writer is not in the trusted set for this surface",
        });
      }
      if (!policy.trustedOrigins.includes(originSurface)) {
        findings.push({
          kind: "untrusted-origin", source: record.source, recordId: record.id,
          detail: "origin surface is not in the trusted set for this surface",
        });
      }
    } else {
      findings.push({
        kind: "missing-stamp", source: record.source, recordId: record.id,
        detail: "record carries no valid provenance stamp (writer, authority, originSurface, stampedAt)",
      });
    }
    const haystack = `${record.id}\n${record.content}`;
    const canaryHits = policy.canaries.filter((canary) => canary.length > 0 && haystack.includes(canary));
    if (canaryHits.length > 0) {
      findings.push({
        kind: "canary-hit", source: record.source, recordId: record.id,
        detail: `content matches ${canaryHits.length} known canary string(s)`,
      });
    }
  }
  return { checked: records.length, findings };
}

export interface CollectedDurableState {
  readonly storePresent: boolean;
  readonly records: readonly DurableStateRecord[];
  readonly unreadable?: string;
}

/**
 * Tolerant reader for the project-memory store. Unlike the store's own
 * fail-closed loader, attestation must be able to READ a poisoned or legacy
 * store in order to report it, so parse errors become findings rather than
 * thrown errors.
 */
export async function collectProjectMemoryRecords(dataRoot: string, workspaceRoot: string): Promise<CollectedDurableState> {
  let canonical: string;
  try {
    canonical = await realpath(workspaceRoot);
  } catch {
    return { storePresent: false, records: [], unreadable: "workspace root is not an existing directory" };
  }
  const file = join(dataRoot, `${createHash("sha256").update(canonical).digest("hex")}.json`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { storePresent: false, records: [] };
    return { storePresent: true, records: [], unreadable: "store is unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { storePresent: true, records: [], unreadable: "store is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { storePresent: true, records: [], unreadable: "store is malformed" };
  const recordsValue = (parsed as { records?: unknown }).records;
  if (!Array.isArray(recordsValue)) return { storePresent: true, records: [], unreadable: "store has no records array" };
  const records: DurableStateRecord[] = [];
  for (const value of recordsValue) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const provenance = record.provenance && typeof record.provenance === "object"
      ? record.provenance as Record<string, unknown>
      : {};
    records.push({
      source: "project-memory",
      id: typeof record.id === "string" && record.id.length > 0 ? record.id : "<unknown>",
      content: typeof record.content === "string" ? record.content : "",
      ...(typeof provenance.writer === "string" ? { writer: provenance.writer } : {}),
      ...(isDurableWriterAuthority(provenance.authority) ? { authority: provenance.authority } : {}),
      ...(typeof provenance.originSurface === "string" ? { originSurface: provenance.originSurface } : {}),
      ...(typeof provenance.stampedAt === "number" ? { stampedAt: provenance.stampedAt } : {}),
    });
  }
  return { storePresent: true, records };
}

/** The project-memory collector plus the rule engine, bound for a workspace. */
export async function attestProjectMemory(input: {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly policy: AttestationPolicy;
}): Promise<DurableStateAttestation> {
  const collected = await collectProjectMemoryRecords(input.dataRoot, input.workspaceRoot);
  const evaluated = attestDurableState(collected.records, input.policy);
  const findings: AttestationFinding[] = [...evaluated.findings];
  if (collected.unreadable !== undefined) {
    findings.unshift({ kind: "unreadable-store", source: "project-memory", recordId: "<store>", detail: collected.unreadable });
  }
  return {
    checked: evaluated.checked,
    findings,
    flagged: findings.length > 0,
    storePresent: collected.storePresent,
  };
}

/** Whether a clean attestation allows project-memory recall into the prompt. */
export function memoryRecallAllowed(attestation: DurableStateAttestation): boolean {
  return !attestation.flagged;
}

/** Bounded operator-facing report; never echoes secret or canary values. */
export function formatAttestationReport(attestation: DurableStateAttestation): string {
  const header = attestation.storePresent
    ? `Durable-state attestation (advisory observability, not enforcement): checked ${attestation.checked} project-memory record(s); ${attestation.findings.length} finding(s).`
    : "Durable-state attestation (advisory observability, not enforcement): no project-memory store present.";
  const lines = attestation.findings.map((finding) => `- [${finding.kind}] ${finding.source}/${finding.recordId}: ${finding.detail}`);
  return [header, ...lines].join("\n");
}