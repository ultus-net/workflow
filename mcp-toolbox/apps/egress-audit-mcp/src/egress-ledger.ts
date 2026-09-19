import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * W052 slice 3: `egress-audit-mcp` ledger core.
 *
 * An append-only, bounded ledger of egress reaches: which destination domain
 * was reached, under which function class, and with which token class, with
 * anomaly flags computed against the prior ledger state at append time. It is
 * **advisory evidence** — it never enforces egress policy and never mutates
 * Workflow state. Enforcement lives at the proxy/policy boundary; see
 * `docs/EGRESS_CAPABILITY_AUDIT.md`.
 *
 * Append-only by construction: entries are only ever added; a full or oversized
 * ledger refuses new appends rather than rotating or deleting history.
 */

export const EGRESS_TOKEN_CLASSES = ["session-placeholder", "absent", "foreign", "unknown"] as const;
export type EgressTokenClass = (typeof EGRESS_TOKEN_CLASSES)[number];

/**
 * Suggested function classes, not a closed set: a new class is exactly what
 * the `new-function-class-on-known-domain` anomaly is meant to surface, so
 * callers may report a bounded identity string instead.
 */
export const SUGGESTED_FUNCTION_CLASSES = ["chat-completions", "models-list", "file-upload", "webhook", "embeddings", "unknown"] as const;

export const EGRESS_ANOMALY_FLAGS = ["new-domain", "new-function-class-on-known-domain", "non-session-token-observed"] as const;
export type EgressAnomalyFlag = (typeof EGRESS_ANOMALY_FLAGS)[number];

export interface EgressReach {
  readonly id: string;
  readonly domain: string;
  readonly functionClass: string;
  readonly tokenClass: EgressTokenClass;
  readonly source: string;
  readonly observedAt: number;
  readonly recordedAt: number;
  readonly anomalies: readonly EgressAnomalyFlag[];
}

export interface AppendReachInput {
  readonly domain: string;
  readonly functionClass: string;
  readonly tokenClass: EgressTokenClass;
  readonly source?: string;
  readonly observedAt?: number;
}

export interface QueryReachInput {
  readonly domain?: string;
  readonly functionClass?: string;
  readonly flaggedOnly?: boolean;
  readonly since?: number;
  readonly limit?: number;
}

export interface QueryReachResult {
  readonly reaches: readonly EgressReach[];
  readonly truncated: boolean;
}

export interface EgressSummary {
  readonly entries: number;
  readonly byDomain: readonly { readonly key: string; readonly count: number }[];
  readonly byFunctionClass: readonly { readonly key: string; readonly count: number }[];
  readonly byTokenClass: readonly { readonly key: string; readonly count: number }[];
  readonly anomalies: readonly { readonly flag: EgressAnomalyFlag; readonly count: number }[];
}

interface LedgerDocument {
  version: 1;
  entries: EgressReach[];
}

const MAX_ENTRIES = 5000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_IDENTITY = 200;

function isIdentity(value: unknown, max = MAX_IDENTITY): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\0\r\n]/.test(value);
}

/**
 * Domains are hostnames only: no scheme, path, port, userinfo, or whitespace.
 * Lowercased so `API.Example.COM` and `api.example.com` are one destination.
 */
export function normalizeDomain(value: string): string {
  if (!isIdentity(value, 253)) throw new Error("Egress reach domain must be a non-empty hostname.");
  const domain = value.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error("Egress reach domain must be a bare hostname (no scheme, path, port, or userinfo).");
  }
  // A bare IPv4 literal is a hostname shape but not a domain; recording it as
  // one would blur the domain/function accounting this ledger exists for.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) {
    throw new Error("Egress reach domain must be a hostname, not an IP literal.");
  }
  return domain;
}

function isTokenClass(value: unknown): value is EgressTokenClass {
  return (EGRESS_TOKEN_CLASSES as readonly unknown[]).includes(value);
}

function isFunctionClass(value: unknown): value is string {
  return isIdentity(value, 120);
}

export function isEgressReach(value: unknown): value is EgressReach {
  if (!value || typeof value !== "object") return false;
  const reach = value as Partial<EgressReach>;
  return isIdentity(reach.id) && isIdentity(reach.domain)
    && isFunctionClass(reach.functionClass) && isTokenClass(reach.tokenClass)
    && isIdentity(reach.source)
    && typeof reach.observedAt === "number" && Number.isSafeInteger(reach.observedAt) && reach.observedAt >= 0
    && typeof reach.recordedAt === "number" && Number.isSafeInteger(reach.recordedAt) && reach.recordedAt >= 0
    && Array.isArray(reach.anomalies) && reach.anomalies.every((flag) => (EGRESS_ANOMALY_FLAGS as readonly unknown[]).includes(flag));
}

/**
 * Anomalies are derived from the prior ledger state only, so a recorded reach
 * is immutable and its flags never change as later reaches arrive.
 */
export function computeAnomalies(existing: readonly EgressReach[], candidate: { domain: string; functionClass: string; tokenClass: EgressTokenClass }): EgressAnomalyFlag[] {
  const anomalies: EgressAnomalyFlag[] = [];
  const knownDomain = existing.some((reach) => reach.domain === candidate.domain);
  if (!knownDomain) {
    anomalies.push("new-domain");
  } else if (!existing.some((reach) => reach.domain === candidate.domain && reach.functionClass === candidate.functionClass)) {
    anomalies.push("new-function-class-on-known-domain");
  }
  if (candidate.tokenClass === "foreign" || candidate.tokenClass === "unknown") {
    anomalies.push("non-session-token-observed");
  }
  return anomalies;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Egress audit operation cancelled.");
}

export class EgressAuditLedger {
  private readonly writes = new Map<string, Promise<void>>();

  private readonly maxEntries: number;

  constructor(private readonly dataRoot: string, options: { readonly maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("Egress audit ledger maxEntries must be a positive integer.");
    this.maxEntries = maxEntries;
  }

  private path(): string {
    return join(this.dataRoot, "egress-audit-ledger.json");
  }

  private async load(): Promise<LedgerDocument> {
    const path = this.path();
    try {
      const info = await stat(path);
      if (info.size > MAX_STORE_BYTES) throw new Error("Egress audit ledger exceeds its size limit.");
      const raw = await readFile(path, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") throw new Error();
      const document = value as Partial<LedgerDocument>;
      if (document.version !== 1 || !Array.isArray(document.entries) || document.entries.length > this.maxEntries || !document.entries.every(isEgressReach)) throw new Error();
      return document as LedgerDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      if (error instanceof Error && error.message.includes("size limit")) throw error;
      throw new Error("Egress audit ledger is malformed or unreadable.");
    }
  }

  private async persist(document: LedgerDocument, signal?: AbortSignal): Promise<void> {
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("Egress audit ledger exceeds its size limit.");
    abortIfNeeded(signal);
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const path = this.path();
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      abortIfNeeded(signal);
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async append(input: AppendReachInput, signal?: AbortSignal): Promise<EgressReach> {
    abortIfNeeded(signal);
    const domain = normalizeDomain(input.domain);
    if (!isFunctionClass(input.functionClass)) throw new Error("Egress reach function class must be 1-120 characters.");
    if (!isTokenClass(input.tokenClass)) throw new Error("Egress reach token class is invalid.");
    const source = input.source ?? "unspecified";
    if (!isIdentity(source, 120)) throw new Error("Egress reach source must be 1-120 characters.");
    const observedAt = input.observedAt ?? Date.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("Egress reach observedAt must be a non-negative integer.");

    let stored!: EgressReach;
    const key = this.dataRoot;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      abortIfNeeded(signal);
      const document = await this.load();
      if (document.entries.length >= this.maxEntries) {
        throw new Error("Egress audit ledger is full; appends are refused (append-only: history is never rotated or deleted).");
      }
      stored = {
        id: randomUUID(),
        domain,
        functionClass: input.functionClass,
        tokenClass: input.tokenClass,
        source,
        observedAt,
        recordedAt: Date.now(),
        anomalies: computeAnomalies(document.entries, { domain, functionClass: input.functionClass, tokenClass: input.tokenClass }),
      };
      document.entries.push(stored);
      await this.persist(document, signal);
    });
    this.writes.set(key, write);
    try {
      await write;
      return stored;
    } finally {
      if (this.writes.get(key) === write) this.writes.delete(key);
    }
  }

  async query(input: QueryReachInput, signal?: AbortSignal): Promise<QueryReachResult> {
    abortIfNeeded(signal);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Egress audit query limit must be 1-200.");
    const domain = input.domain === undefined ? undefined : normalizeDomain(input.domain);
    if (input.functionClass !== undefined && !isFunctionClass(input.functionClass)) throw new Error("Egress audit query function class is invalid.");
    if (input.since !== undefined && (!Number.isSafeInteger(input.since) || input.since < 0)) throw new Error("Egress audit query since must be a non-negative integer.");
    const document = await this.load();
    abortIfNeeded(signal);
    const matched = document.entries.filter((reach) =>
      (domain === undefined || reach.domain === domain)
      && (input.functionClass === undefined || reach.functionClass === input.functionClass)
      && (input.flaggedOnly !== true || reach.anomalies.length > 0)
      && (input.since === undefined || reach.observedAt >= input.since));
    const sorted = matched.slice().sort((a, b) => b.observedAt - a.observedAt || b.recordedAt - a.recordedAt || a.id.localeCompare(b.id));
    return { reaches: sorted.slice(0, limit), truncated: matched.length > limit };
  }

  async summarize(signal?: AbortSignal): Promise<EgressSummary> {
    abortIfNeeded(signal);
    const document = await this.load();
    abortIfNeeded(signal);
    return {
      entries: document.entries.length,
      byDomain: topCounts(document.entries.map((reach) => reach.domain)),
      byFunctionClass: topCounts(document.entries.map((reach) => reach.functionClass)),
      byTokenClass: topCounts(document.entries.map((reach) => reach.tokenClass)),
      anomalies: EGRESS_ANOMALY_FLAGS.map((flag) => ({
        flag,
        count: document.entries.filter((reach) => reach.anomalies.includes(flag)).length,
      })),
    };
  }
}

const SUMMARY_TOP = 50;

function topCounts(values: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, SUMMARY_TOP);
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EGRESS_AUDIT_DATA_DIR) return resolve(env.EGRESS_AUDIT_DATA_DIR);
  if (env.XDG_DATA_HOME) return join(resolve(env.XDG_DATA_HOME), "egress-audit-mcp");
  if (!env.HOME) throw new Error("HOME is required when no egress audit data directory is configured.");
  return join(resolve(homedir()), ".local", "share", "egress-audit-mcp");
}