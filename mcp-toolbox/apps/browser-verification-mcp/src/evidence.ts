import { createHash, randomUUID } from "node:crypto";

import type { Profile } from "./bounds.js";

/**
 * Evidence contract for browser verification.
 *
 * Every bounded action produces an observation with a deterministic SHA-256
 * stamp over its canonical body. The stamp is a structure/provenance check,
 * not a truth check and not a signature: page content is untrusted input, and
 * the record is only as trustworthy as the browser/CDP connection that
 * produced it. The shape is what `verification-accountability-mcp` admits as
 * external evidence (source/observed-by, subject, outcome).
 */

export type EvidenceActionKind = "navigate" | "snapshot" | "action" | "screenshot" | "assert" | "verify_flow" | "debug";

export interface BrowserEvidenceSource {
  readonly kind: "browser_verification";
  readonly capability: string;
  readonly profile: Profile;
}

export interface BrowserEvidenceSubject {
  readonly kind: "browser_page";
  readonly url: string;
  readonly origin: string;
  readonly pageHash: string;
}

export interface BrowserEvidenceResult {
  readonly outcome: "observed" | "passed" | "failed" | "inconclusive";
  readonly summary: string;
  readonly assertions?: { readonly passed: number; readonly failed: number };
  readonly truncated: boolean;
}

export interface BrowserEvidenceRecord {
  readonly id: string;
  readonly evidenceClass: "observation";
  readonly source: BrowserEvidenceSource;
  readonly action: { readonly kind: EvidenceActionKind; readonly detail: Record<string, unknown> };
  readonly subject: BrowserEvidenceSubject;
  readonly result: BrowserEvidenceResult;
  readonly urlBefore: string;
  readonly urlAfter: string;
  readonly recordedAt: number;
  readonly hash: string;
  readonly previousHash: string | null;
  readonly provenance: { readonly tool: string; readonly targetId: string; readonly sessionId: string };
}

export interface EvidenceInput {
  readonly capability: string;
  readonly profile: Profile;
  readonly actionKind: EvidenceActionKind;
  readonly detail: Record<string, unknown>;
  readonly subject: BrowserEvidenceSubject;
  readonly result: BrowserEvidenceResult;
  readonly urlBefore: string;
  readonly urlAfter: string;
  readonly provenance: { readonly tool: string; readonly targetId: string; readonly sessionId: string };
  readonly previousHash: string | null;
  readonly now?: number;
}

/** Deterministic JSON with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash a page identity from its URL and title (not a full-DOM digest). */
export function pageHash(url: string, title: string): string {
  return sha256(`${url}\n${title}`);
}

export function buildEvidence(input: EvidenceInput): BrowserEvidenceRecord {
  const body = {
    id: randomUUID(),
    evidenceClass: "observation" as const,
    source: { kind: "browser_verification" as const, capability: input.capability, profile: input.profile },
    action: { kind: input.actionKind, detail: input.detail },
    subject: input.subject,
    result: input.result,
    urlBefore: input.urlBefore,
    urlAfter: input.urlAfter,
    recordedAt: input.now ?? Date.now(),
    hash: "",
    previousHash: input.previousHash,
    provenance: input.provenance,
  };
  const hash = sha256(stableStringify({ ...body, hash: undefined }));
  return { ...body, hash };
}

const HEX64 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
}

export function validEvidenceHash(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/**
 * Structural admission check. Deliberately validates shape and the internal
 * hash only — it never claims the observed page content is true.
 */
export function validateEvidenceShape(value: unknown): value is BrowserEvidenceRecord {
  if (!isRecord(value)) return false;
  if (!boundedString(value.id, 64) || value.evidenceClass !== "observation") return false;
  if (!validEvidenceHash(value.hash)) return false;
  if (value.previousHash !== null && !validEvidenceHash(value.previousHash)) return false;
  if (!Number.isSafeInteger(value.recordedAt) || (value.recordedAt as number) < 0) return false;
  const source = value.source;
  if (!isRecord(source) || source.kind !== "browser_verification" || !boundedString(source.capability, 200)) return false;
  if (source.profile !== "verification" && source.profile !== "debug") return false;
  const action = value.action;
  if (!isRecord(action) || !boundedString(action.kind, 40) || !isRecord(action.detail)) return false;
  const subject = value.subject;
  if (!isRecord(subject) || subject.kind !== "browser_page") return false;
  if (!boundedString(subject.url, 2048) || !boundedString(subject.origin, 2048) || !validEvidenceHash(subject.pageHash)) return false;
  const result = value.result;
  if (!isRecord(result) || !["observed", "passed", "failed", "inconclusive"].includes(result.outcome as string)) return false;
  if (!boundedString(result.summary, 2_000) || typeof result.truncated !== "boolean") return false;
  if (result.assertions !== undefined) {
    if (!isRecord(result.assertions)) return false;
    if (!Number.isSafeInteger(result.assertions.passed) || !Number.isSafeInteger(result.assertions.failed)) return false;
  }
  if (!boundedString(value.urlBefore, 2048) || !boundedString(value.urlAfter, 2048)) return false;
  const provenance = value.provenance;
  if (!isRecord(provenance) || !boundedString(provenance.tool, 100) || !boundedString(provenance.targetId, 200) || !boundedString(provenance.sessionId, 200)) return false;
  return true;
}

/** Recompute the record's hash to confirm the stamp covers the body. */
export function verifyEvidenceHash(record: BrowserEvidenceRecord): boolean {
  const hash = sha256(stableStringify({ ...record, hash: undefined }));
  return hash === record.hash;
}

/** Subset consumed as external evidence by verification-accountability-mcp. */
export function browserEvidenceSummary(record: BrowserEvidenceRecord): {
  capability: string;
  evidenceId: string;
  evidenceHash: string;
  observedAt: number;
  url: string;
  origin: string;
  pageHash: string;
  outcome: BrowserEvidenceResult["outcome"];
  passed: number;
  failed: number;
  truncated: boolean;
} {
  return {
    capability: record.source.capability,
    evidenceId: record.id,
    evidenceHash: record.hash,
    observedAt: record.recordedAt,
    url: record.subject.url,
    origin: record.subject.origin,
    pageHash: record.subject.pageHash,
    outcome: record.result.outcome,
    passed: record.result.assertions?.passed ?? 0,
    failed: record.result.assertions?.failed ?? 0,
    truncated: record.result.truncated,
  };
}