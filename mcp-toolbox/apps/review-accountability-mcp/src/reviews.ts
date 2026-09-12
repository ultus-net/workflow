import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Subject =
  | { kind: "commit"; repository: string; commit: string }
  | { kind: "fingerprint"; algorithm: string; version: string; scope: string; value: string };

export interface Finding { severity: Severity; summary: string; paths: string[] }
export interface FollowUp extends Finding {
  id: string; reviewId: string; status: "open" | "resolved"; createdAt: number; resolvedAt?: number; resolution?: string;
}
export interface ReviewAttestation {
  id: string; reviewer: string; verdict: "approved" | "changes_requested"; subject: Subject;
  blockingSeverities: Severity[]; findings: Finding[]; createdAt: number; evidenceClass: "attestation";
  provenance: { origin: "review-accountability-mcp/record_review"; workspace: string };
  freshness: "fresh" | "stale" | "unknown"; followUps: FollowUp[];
}
export interface RecordReviewInput {
  workspaceRoot: string; reviewer: string; verdict: ReviewAttestation["verdict"]; subject: Subject;
  blockingSeverities: Severity[]; findings: Finding[];
}
export interface ListReviewsInput { workspaceRoot: string; currentSubject?: Subject; limit?: number; followUpLimit?: number }
export interface ResolveFollowUpInput { workspaceRoot: string; followUpId: string; resolution: string }

interface StoredReview extends Omit<ReviewAttestation, "provenance" | "freshness" | "followUps"> {}
interface StoreDocument { version: 1; workspace: string; reviews: StoredReview[]; followUps: FollowUp[] }

const MAX_REVIEWS = 500;
const MAX_FINDINGS = 20;
const MAX_STORE_BYTES = 5 * 1024 * 1024;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Review accountability operation cancelled.");
}
function containsSecret(value: string): boolean { return SECRET_PATTERNS.some((pattern) => pattern.test(value)); }
function boundedText(value: string, name: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > max || /[\0\r\n]/.test(trimmed)) throw new Error(`${name} is invalid or exceeds its limit.`);
  if (containsSecret(trimmed)) throw new Error("Review content appears to contain a secret and was not stored.");
  return trimmed;
}
async function canonicalWorkspace(workspaceRoot: string): Promise<string> {
  if (!isAbsolute(workspaceRoot) || /[\0\r\n]/.test(workspaceRoot)) throw new Error("Workspace root must be an absolute directory.");
  try {
    const canonical = await realpath(workspaceRoot);
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    return canonical;
  } catch { throw new Error("Workspace root must be an existing directory."); }
}
function subjectKey(subject: Subject): string {
  return subject.kind === "commit"
    ? `commit\0${subject.repository}\0${subject.commit}`
    : `fingerprint\0${subject.algorithm}\0${subject.version}\0${subject.scope}\0${subject.value}`;
}
function comparable(left: Subject, right: Subject): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "commit" && right.kind === "commit") return left.repository === right.repository;
  return left.kind === "fingerprint" && right.kind === "fingerprint" && left.algorithm === right.algorithm && left.version === right.version && left.scope === right.scope;
}
function freshness(subject: Subject, current?: Subject): ReviewAttestation["freshness"] {
  if (!current || !comparable(subject, current)) return "unknown";
  return subjectKey(subject) === subjectKey(current) ? "fresh" : "stale";
}
function validStoredFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<Finding>;
  return typeof finding.summary === "string" && SEVERITIES.includes(finding.severity as Severity) && Array.isArray(finding.paths) && finding.paths.every((path) => typeof path === "string");
}
function validStoredSubject(value: unknown): value is Subject {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === "commit"
    ? typeof candidate.repository === "string" && typeof candidate.commit === "string"
    : candidate.kind === "fingerprint" && [candidate.algorithm, candidate.version, candidate.scope, candidate.value].every((part) => typeof part === "string");
}
function validStoredReview(value: unknown): value is StoredReview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<StoredReview>;
  return typeof review.id === "string" && typeof review.reviewer === "string" && (review.verdict === "approved" || review.verdict === "changes_requested") && validStoredSubject(review.subject) && review.evidenceClass === "attestation" && typeof review.createdAt === "number" && Array.isArray(review.blockingSeverities) && review.blockingSeverities.every((severity) => SEVERITIES.includes(severity)) && Array.isArray(review.findings) && review.findings.every(validStoredFinding);
}
function validStoredFollowUp(value: unknown): value is FollowUp {
  if (!validStoredFinding(value)) return false;
  const followUp = value as Partial<FollowUp>;
  return (followUp.severity === "P2" || followUp.severity === "P3") && typeof followUp.id === "string" && typeof followUp.reviewId === "string" && (followUp.status === "open" || followUp.status === "resolved") && typeof followUp.createdAt === "number";
}
function validateSubject(subject: Subject, workspace: string): Subject {
  if (subject.kind === "commit") {
    if (subject.repository !== workspace || !/^[0-9a-fA-F]{40,64}$/.test(subject.commit)) throw new Error("Invalid review commit subject.");
    return { ...subject, commit: subject.commit.toLowerCase() };
  }
  for (const value of [subject.algorithm, subject.version, subject.scope, subject.value]) boundedText(value, "Fingerprint subject", 200);
  return { ...subject };
}
async function validatePath(workspace: string, path: string): Promise<string> {
  if (!path || path.length > 500 || isAbsolute(path) || /[\0\r\n]/.test(path) || containsSecret(path)) throw new Error("Invalid review path.");
  const target = resolve(workspace, path);
  const rel = relative(workspace, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Invalid review path.");
  return rel;
}

export class ReviewStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly dataRoot: string) {}
  private pathFor(workspace: string): string { return join(this.dataRoot, `${createHash("sha256").update(workspace).digest("hex")}.json`); }
  private async load(workspace: string): Promise<StoreDocument> {
    try {
      const path = this.pathFor(workspace);
      if ((await stat(path)).size > MAX_STORE_BYTES) throw new Error("Review store exceeds its size limit.");
      const parsed = JSON.parse(await readFile(path, "utf8")) as StoreDocument;
      if (parsed.version !== 1 || parsed.workspace !== workspace || !Array.isArray(parsed.reviews) || !Array.isArray(parsed.followUps) || parsed.reviews.length > MAX_REVIEWS || !parsed.reviews.every(validStoredReview) || !parsed.followUps.every(validStoredFollowUp)) throw new Error();
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspace, reviews: [], followUps: [] };
      if (error instanceof Error && error.message.includes("size limit")) throw error;
      throw new Error("Review accountability store is malformed or unreadable.");
    }
  }
  private async persist(workspace: string, document: StoreDocument, signal?: AbortSignal): Promise<void> {
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("Review store exceeds its size limit.");
    abortIfNeeded(signal);
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const path = this.pathFor(workspace);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      abortIfNeeded(signal);
      await rename(temporary, path);
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  private async mutate<T>(workspace: string, operation: (document: StoreDocument) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    let result!: T;
    const previous = this.writes.get(workspace) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      abortIfNeeded(signal);
      const document = await this.load(workspace);
      result = await operation(document);
      await this.persist(workspace, document, signal);
    });
    this.writes.set(workspace, write);
    try { await write; return result; } finally { if (this.writes.get(workspace) === write) this.writes.delete(workspace); }
  }
  async recordReview(input: RecordReviewInput, signal?: AbortSignal): Promise<ReviewAttestation> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    const reviewer = boundedText(input.reviewer, "Reviewer", 200);
    if (!input.blockingSeverities.length || new Set(input.blockingSeverities).size !== input.blockingSeverities.length || !input.blockingSeverities.every((value) => SEVERITIES.includes(value))) throw new Error("Blocking severities are invalid.");
    if (input.findings.length > MAX_FINDINGS) throw new Error(`Review findings exceed the limit of ${MAX_FINDINGS}.`);
    if (input.verdict === "approved" && input.findings.some((finding) => input.blockingSeverities.includes(finding.severity))) throw new Error("An approved review cannot contain a configured blocking severity.");
    const subject = validateSubject(input.subject, workspace);
    const findings: Finding[] = [];
    for (const finding of input.findings) {
      if (!SEVERITIES.includes(finding.severity)) throw new Error("Invalid finding severity.");
      if (finding.paths.length > 20) throw new Error("Finding paths exceed the limit of 20.");
      const paths: string[] = [];
      for (const path of finding.paths) paths.push(await validatePath(workspace, path));
      findings.push({ severity: finding.severity, summary: boundedText(finding.summary, "Finding summary", 1024), paths });
    }
    return this.mutate(workspace, (document) => {
      if (document.reviews.length >= MAX_REVIEWS) throw new Error("Review record limit reached.");
      const createdAt = Date.now();
      const review: StoredReview = { id: randomUUID(), reviewer, verdict: input.verdict, subject, blockingSeverities: [...input.blockingSeverities], findings, createdAt, evidenceClass: "attestation" };
      const followUps = findings.filter((finding) => finding.severity === "P2" || finding.severity === "P3").map((finding) => ({ ...finding, id: randomUUID(), reviewId: review.id, status: "open" as const, createdAt }));
      document.reviews.push(review); document.followUps.push(...followUps);
      return { ...review, provenance: { origin: "review-accountability-mcp/record_review" as const, workspace }, freshness: "unknown" as const, followUps };
    }, signal);
  }
  async listReviews(input: ListReviewsInput, signal?: AbortSignal): Promise<{ reviews: ReviewAttestation[]; openFollowUps: FollowUp[]; truncated: boolean; followUpsTruncated: boolean }> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Review list limit must be 1-50.");
    const followUpLimit = input.followUpLimit ?? 20;
    if (!Number.isInteger(followUpLimit) || followUpLimit < 1 || followUpLimit > 50) throw new Error("Follow-up list limit must be 1-50.");
    const current = input.currentSubject ? validateSubject(input.currentSubject, workspace) : undefined;
    const document = await this.load(workspace);
    const ordered = [...document.reviews].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const selected = ordered.slice(0, limit).map((review) => ({ ...review, provenance: { origin: "review-accountability-mcp/record_review" as const, workspace }, freshness: freshness(review.subject, current), followUps: document.followUps.filter((item) => item.reviewId === review.id) }));
    const openFollowUps = document.followUps.filter((item) => item.status === "open");
    return { reviews: selected, openFollowUps: openFollowUps.slice(0, followUpLimit), truncated: ordered.length > limit, followUpsTruncated: openFollowUps.length > followUpLimit };
  }
  async resolveFollowUp(input: ResolveFollowUpInput, signal?: AbortSignal): Promise<FollowUp> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    const resolution = boundedText(input.resolution, "Follow-up resolution", 1024);
    if (!input.followUpId || input.followUpId.length > 200 || /[\0\r\n]/.test(input.followUpId)) throw new Error("Invalid follow-up ID.");
    return this.mutate(workspace, (document) => {
      const followUp = document.followUps.find((item) => item.id === input.followUpId && item.status === "open");
      if (!followUp) throw new Error("Follow-up ID must identify an open follow-up in this project.");
      followUp.status = "resolved"; followUp.resolvedAt = Date.now(); followUp.resolution = resolution;
      return { ...followUp };
    }, signal);
  }
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REVIEW_ACCOUNTABILITY_DATA_DIR) return resolve(env.REVIEW_ACCOUNTABILITY_DATA_DIR);
  if (env.XDG_DATA_HOME) return join(resolve(env.XDG_DATA_HOME), "review-accountability-mcp");
  if (!env.HOME) throw new Error("HOME is required when no review accountability data directory is configured.");
  return join(resolve(env.HOME), ".local", "share", "review-accountability-mcp");
}
