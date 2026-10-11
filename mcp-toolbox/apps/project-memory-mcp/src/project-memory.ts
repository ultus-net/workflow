import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const MEMORY_KINDS = ["fact", "decision", "constraint", "lesson"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * W054: every durable record carries a provenance stamp naming who wrote it
 * (writer identity), the surface it came through (origin surface), and when
 * (stampedAt). The stamp is server configuration set at launch, never a
 * tool argument, so an agent cannot forge a different writer in-band. A
 * missing stamp fails the write loudly rather than being silently accepted.
 */
export const MEMORY_WRITER_AUTHORITIES = ["operator", "agent", "external-evidence"] as const;
export type MemoryWriterAuthority = (typeof MEMORY_WRITER_AUTHORITIES)[number];

export interface MemoryStampConfig {
  writer: string;
  authority: MemoryWriterAuthority;
  originSurface: string;
}

/**
 * A record is either authored here (`record_memory`) or imported from the
 * repo-local portable JSONL (`import_memory`). The origin names the path the
 * bytes took, never whether the assertion is true, and imported records stay
 * distinguishable so a portable file cannot silently relabel itself as a
 * locally-authored write.
 */
export const MEMORY_ORIGINS = ["project-memory-mcp/record_memory", "project-memory-mcp/import_memory"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export interface StoredProvenance {
  origin: MemoryOrigin;
  writer: string;
  authority: MemoryWriterAuthority;
  originSurface: string;
  stampedAt: number;
}

export interface MemoryProvenance extends StoredProvenance {
  workspace: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  content: string;
  paths: string[];
  createdAt: number;
  supersedes?: string;
  /** When this record was superseded (absent while it is current). */
  supersededAt?: number;
  status: "current" | "superseded";
  evidenceClass: "assertion";
  freshness: "fresh" | "stale";
  provenance: MemoryProvenance;
}

export interface RecordInput {
  workspaceRoot: string;
  kind: MemoryKind;
  content: string;
  paths?: string[];
  supersedes?: string;
}

export interface SearchInput { workspaceRoot: string; query: string; limit?: number }
export interface SearchResult { records: MemoryRecord[]; truncated: boolean }

export interface ImportInput { workspaceRoot: string; path?: string }
export interface ImportResult { imported: number; skipped: number; rejected: number; path: string }
export interface ExportInput { workspaceRoot: string; ids?: string[]; path?: string }
export interface ExportResult { exported: number; path: string }

/** One parsed, structurally-valid line of a portable JSONL file. */
interface PortableEntry { id: string; kind: MemoryKind; content: string; paths: string[]; supersedes?: string }

interface StoredRecord extends Omit<MemoryRecord, "freshness" | "provenance"> { provenance: StoredProvenance }
interface StoreDocument { version: 1; workspace: string; records: StoredRecord[] }

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention window for records that are no longer current. Superseded records
 * are kept for this long (so a recent reversal is still inspectable), then
 * pruned. Current records are never age-pruned: a record only leaves the store
 * by explicit supersession or operator deletion, so retention bounds growth
 * without silently dropping live knowledge. The window is configurable via
 * `PROJECT_MEMORY_RETENTION_DAYS` (a positive integer number of days); zero or
 * malformed values fall back to the default rather than disabling retention.
 */
export const DEFAULT_RETENTION_DAYS = 90;
export const RETENTION_ENV_VAR = "PROJECT_MEMORY_RETENTION_DAYS";

export function resolveRetentionWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RETENTION_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS * DAY_MS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0) return DEFAULT_RETENTION_DAYS * DAY_MS;
  return days * DAY_MS;
}

const MAX_RECORDS = 1000;
const MAX_STORE_BYTES = 5 * 1024 * 1024;
const MAX_PORTABLE_RECORDS = 1000;
const MAX_PORTABLE_BYTES = 1_000_000;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Project memory operation cancelled.");
}

function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value);
}

export function isMemoryStampConfig(value: unknown): value is MemoryStampConfig {
  if (!value || typeof value !== "object") return false;
  const stamp = value as Partial<MemoryStampConfig>;
  return isIdentity(stamp.writer) && isIdentity(stamp.originSurface)
    && MEMORY_WRITER_AUTHORITIES.includes(stamp.authority as MemoryWriterAuthority);
}

function isStoredProvenance(value: unknown): value is StoredProvenance {
  if (!value || typeof value !== "object") return false;
  const provenance = value as Partial<StoredProvenance>;
  return MEMORY_ORIGINS.includes(provenance.origin as MemoryOrigin)
    && isIdentity(provenance.writer)
    && isIdentity(provenance.originSurface)
    && MEMORY_WRITER_AUTHORITIES.includes(provenance.authority as MemoryWriterAuthority)
    && typeof provenance.stampedAt === "number" && Number.isSafeInteger(provenance.stampedAt) && provenance.stampedAt >= 0;
}

function publicRecord(record: StoredRecord, workspace: string): MemoryRecord {
  return {
    ...record,
    freshness: record.status === "current" ? "fresh" : "stale",
    provenance: { ...record.provenance, workspace },
  };
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredRecord>;
  return typeof record.id === "string" && record.id.length > 0 && record.id.length <= 200
    && !/[\0\r\n]/.test(record.id)
    && MEMORY_KINDS.includes(record.kind as MemoryKind)
    && typeof record.content === "string" && record.content.trim() === record.content && record.content.length > 0 && Buffer.byteLength(record.content) <= 4096
    && !containsSecret(record.content)
    && Array.isArray(record.paths) && record.paths.length <= 20 && record.paths.every((path) => {
      if (typeof path !== "string" || !path || path.length > 500 || isAbsolute(path) || /[\0\r\n]/.test(path) || containsSecret(path)) return false;
      const normalized = normalize(path);
      return normalized === path && normalized !== ".." && !normalized.startsWith(`..${sep}`);
    })
    && typeof record.createdAt === "number" && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0
    && (record.supersededAt === undefined || (typeof record.supersededAt === "number" && Number.isSafeInteger(record.supersededAt) && record.supersededAt >= 0))
    && (record.supersedes === undefined || (typeof record.supersedes === "string" && record.supersedes.length > 0 && record.supersedes.length <= 200 && !/[\0\r\n]/.test(record.supersedes)))
    && (record.status === "current" || record.status === "superseded")
    && record.evidenceClass === "assertion"
    && isStoredProvenance(record.provenance);
}

async function canonicalWorkspace(workspaceRoot: string): Promise<string> {
  if (!isAbsolute(workspaceRoot) || /[\0\r\n]/.test(workspaceRoot)) throw new Error("Workspace root must be an absolute directory.");
  let canonical: string;
  try {
    canonical = await realpath(workspaceRoot);
    if (!(await stat(canonical)).isDirectory()) throw new Error();
  } catch {
    throw new Error("Workspace root must be an existing directory.");
  }
  return canonical;
}

async function validateAssociatedPath(workspace: string, input: string): Promise<string> {
  if (!input || input.length > 500 || isAbsolute(input) || /[\0\r\n]/.test(input)) throw new Error("Invalid project memory path.");
  const normalized = normalize(input);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error("Invalid project memory path.");
  const target = resolve(workspace, normalized);
  const targetRelative = relative(workspace, target);
  if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) throw new Error("Invalid project memory path.");

  let probe = target;
  for (;;) {
    try {
      const canonicalProbe = await realpath(probe);
      const rel = relative(workspace, canonicalProbe);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Invalid project memory path.");
      break;
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid project memory path.") throw error;
      if (probe === workspace) throw new Error("Invalid project memory path.");
      probe = dirname(probe);
    }
  }
  return normalized;
}

function tokenize(input: string): string[] {
  return [...new Set((input.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 12))];
}

/**
 * The default portable file is the repo-local, human-readable JSONL the
 * upstream plugin imported and exported: `<workspace>/.opencode/memory/project-memory.jsonl`.
 * It is literally a path inside the workspace, so confinement and secret
 * rejection apply to it exactly like any other associated path.
 */
export function defaultPortablePath(workspace: string): string {
  return join(workspace, ".opencode", "memory", "project-memory.jsonl");
}

/**
 * Parse one portable JSONL line into a structurally-valid entry, or classify
 * why it was rejected. Fields the portable format cannot carry (provenance,
 * timestamps, status) are dropped on import: the importing store stamps the
 * record with its own launch configuration rather than trusting the bytes.
 */
function parsePortableLine(value: unknown): PortableEntry | "rejected" {
  if (!value || typeof value !== "object") return "rejected";
  const entry = value as Partial<PortableEntry>;
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 200 || /[\0\r\n]/.test(entry.id)) return "rejected";
  if (typeof entry.content !== "string" || entry.content.length === 0 || Buffer.byteLength(entry.content) > 4096 || containsSecret(entry.content)) return "rejected";
  if (!MEMORY_KINDS.includes(entry.kind as MemoryKind)) return "rejected";
  const paths = entry.paths ?? [];
  if (!Array.isArray(paths) || paths.length > 20 || !paths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 500 && !containsSecret(path))) return "rejected";
  if (entry.supersedes !== undefined && (typeof entry.supersedes !== "string" || entry.supersedes.length === 0 || entry.supersedes.length > 200 || /[\0\r\n]/.test(entry.supersedes))) return "rejected";
  return { id: entry.id, kind: entry.kind as MemoryKind, content: entry.content, paths, ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }) };
}

function serializePortableEntry(record: StoredRecord): string {
  return JSON.stringify({
    id: record.id, kind: record.kind, content: record.content, paths: record.paths,
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
  });
}

export class ProjectMemoryStore {
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataRoot: string,
    private readonly stamp?: MemoryStampConfig,
    private readonly retentionMs: number = DEFAULT_RETENTION_DAYS * DAY_MS,
  ) {
    if (stamp !== undefined && !isMemoryStampConfig(stamp)) {
      throw new Error("Project memory provenance stamp is malformed.");
    }
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
      throw new Error("Project memory retention window must be a positive number of milliseconds.");
    }
  }

  private pathFor(workspace: string): string {
    return join(this.dataRoot, `${createHash("sha256").update(workspace).digest("hex")}.json`);
  }

  /** Serializes every store mutation for one workspace through one queue. */
  private async mutate<T>(workspace: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(workspace) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      abortIfNeeded(signal);
      return work();
    });
    this.writes.set(workspace, run);
    try {
      return await run;
    } finally {
      if (this.writes.get(workspace) === run) this.writes.delete(workspace);
    }
  }

  /**
   * Age-based retention for records that are no longer current. A superseded
   * record is dropped once `supersededAt` is older than the retention window.
   * Records superseded before this field existed fall back to `createdAt`, so a
   * pre-upgrade store is still bounded. Current records never age out.
   */
  private prune(records: StoredRecord[], now: number): StoredRecord[] {
    const cutoff = now - this.retentionMs;
    return records.filter((record) => record.status !== "superseded" || (record.supersededAt ?? record.createdAt) >= cutoff);
  }

  private async load(workspace: string, signal?: AbortSignal): Promise<StoreDocument> {
    const path = this.pathFor(workspace);
    try {
      const info = await stat(path);
      if (info.size > MAX_STORE_BYTES) throw new Error("Project memory store exceeds its size limit.");
      const raw = await readFile(path, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") throw new Error();
      const document = value as Partial<StoreDocument>;
      if (document.version !== 1 || document.workspace !== workspace || !Array.isArray(document.records) || document.records.length > MAX_RECORDS || !document.records.every(isStoredRecord)) throw new Error();
      const pruned = this.prune(document.records, Date.now());
      if (pruned.length !== document.records.length) {
        // Retention is applied on read and written back only when it removes
        // something, so a bounded store never balloons just by being opened.
        document.records = pruned;
        await this.persist(workspace, document as StoreDocument, signal);
      }
      return document as StoreDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspace, records: [] };
      if (error instanceof Error && (error.message.includes("size limit") || error.message.includes("malformed or unreadable") || error.message.includes("cancelled"))) throw error;
      throw new Error("Project memory store is malformed or unreadable.");
    }
  }

  private async persist(workspace: string, document: StoreDocument, signal?: AbortSignal): Promise<void> {
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("Project memory store exceeds its size limit.");
    abortIfNeeded(signal);
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const path = this.pathFor(workspace);
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

  async record(input: RecordInput, signal?: AbortSignal): Promise<MemoryRecord> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    if (!MEMORY_KINDS.includes(input.kind)) throw new Error("Invalid project memory kind.");
    const content = input.content.trim();
    if (!content || Buffer.byteLength(content) > 4096) throw new Error("Project memory content must be 1-4096 UTF-8 bytes.");
    const paths = input.paths ?? [];
    if (paths.length > 20) throw new Error("Project memory paths exceed the limit of 20.");
    if (containsSecret(content) || paths.some(containsSecret)) throw new Error("Project memory content appears to contain a secret and was not stored.");
    const safePaths: string[] = [];
    for (const path of paths) safePaths.push(await validateAssociatedPath(workspace, path));
    abortIfNeeded(signal);

    return this.mutate(workspace, signal, async () => {
      const document = await this.load(workspace, signal);
      if (document.records.length >= MAX_RECORDS) throw new Error("Project memory record limit reached.");
      let superseded: StoredRecord | undefined;
      if (input.supersedes) {
        if (input.supersedes.length > 200 || /[\0\r\n]/.test(input.supersedes)) throw new Error("Invalid superseded memory ID.");
        superseded = document.records.find((record) => record.id === input.supersedes && record.status === "current");
        if (!superseded) throw new Error("Superseded memory must identify a current memory in this project.");
      }
      const stamp = this.stamp;
      if (stamp === undefined) {
        throw new Error("Project memory writes require a provenance stamp (writer, authority, originSurface); set PROJECT_MEMORY_WRITER, PROJECT_MEMORY_WRITER_AUTHORITY, and PROJECT_MEMORY_ORIGIN_SURFACE at server launch.");
      }
      const now = Date.now();
      const stored: StoredRecord = {
        id: randomUUID(), kind: input.kind, content, paths: safePaths, createdAt: now,
        ...(input.supersedes ? { supersedes: input.supersedes } : {}), status: "current", evidenceClass: "assertion",
        provenance: {
          origin: "project-memory-mcp/record_memory", writer: stamp.writer, authority: stamp.authority,
          originSurface: stamp.originSurface, stampedAt: now,
        },
      };
      if (superseded) {
        superseded.status = "superseded";
        superseded.supersededAt = now;
      }
      document.records.push(stored);
      // Retention runs on every mutation so superseded records age out even in
      // a store that is never otherwise rewritten.
      document.records = this.prune(document.records, now);
      await this.persist(workspace, document, signal);
      return publicRecord(stored, workspace);
    });
  }

  async search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    if (!input.query.trim() || input.query.length > 500) throw new Error("Project memory query must be 1-500 characters.");
    const limit = input.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Project memory search limit must be 1-20.");
    const terms = tokenize(input.query);
    if (terms.length === 0) return { records: [], truncated: false };
    const document = await this.load(workspace, signal);
    abortIfNeeded(signal);
    const matches = document.records.flatMap((record) => {
      if (record.status !== "current") return [];
      const haystack = `${record.kind} ${record.content} ${record.paths.join(" ")}`.toLocaleLowerCase();
      const score = terms.reduce((count, term) => count + Number(haystack.includes(term)), 0);
      return score ? [{ record, score }] : [];
    });
    matches.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt || a.record.id.localeCompare(b.record.id));
    return { records: matches.slice(0, limit).map(({ record }) => publicRecord(record, workspace)), truncated: matches.length > limit };
  }

  /**
   * Export selected current records to the repo-local portable JSONL. With no
   * `ids`, every current record is exported (the human-readable snapshot of
   * the project's durable knowledge); with `ids`, only those records. Secret
   * content is never written out, matching the record path's own refusal.
   */
  async export(input: ExportInput, signal?: AbortSignal): Promise<ExportResult> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    const requested = input.ids ?? [];
    if (requested.length > 100) throw new Error("Project memory export accepts at most 100 record IDs.");
    for (const id of requested) {
      if (id.length === 0 || id.length > 200 || /[\0\r\n]/.test(id)) throw new Error("Invalid project memory record ID.");
    }
    const document = await this.load(workspace, signal);
    const selected = document.records.filter((record) => record.status === "current"
      && (requested.length === 0 || requested.includes(record.id)) && !containsSecret(record.content));
    const path = await this.resolvePortablePath(workspace, input.path);
    const serialized = selected.map(serializePortableEntry).join("\n") + (selected.length > 0 ? "\n" : "");
    abortIfNeeded(signal);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      abortIfNeeded(signal);
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { exported: selected.length, path };
  }

  /**
   * Import the repo-local portable JSONL into the local index. Each valid line
   * becomes a current record stamped with this server's launch configuration;
   * records already present by id are skipped (idempotent re-import). A line
   * that fails structural validation or carries recognizable secret content is
   * rejected and never stored. Bounds mirror the upstream importer: at most
   * 1 MB and 1000 lines are read.
   */
  async import(input: ImportInput, signal?: AbortSignal): Promise<ImportResult> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    const path = await this.resolvePortablePath(workspace, input.path);
    let text: string;
    try {
      const info = await stat(path);
      if (info.size > MAX_PORTABLE_BYTES) return { imported: 0, skipped: 0, rejected: 0, path };
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: 0, skipped: 0, rejected: 0, path };
      throw error;
    }
    const stamp = this.stamp;
    if (stamp === undefined) {
      throw new Error("Project memory imports require a provenance stamp (writer, authority, originSurface); set PROJECT_MEMORY_WRITER, PROJECT_MEMORY_WRITER_AUTHORITY, and PROJECT_MEMORY_ORIGIN_SURFACE at server launch.");
    }
    return this.mutate(workspace, signal, async () => {
      const document = await this.load(workspace, signal);
      const now = Date.now();
      let imported = 0;
      let skipped = 0;
      let rejected = 0;
      for (const line of text.split("\n").filter((candidate) => candidate.trim().length > 0).slice(0, MAX_PORTABLE_RECORDS)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          rejected += 1;
          continue;
        }
        const entry = parsePortableLine(parsed);
        if (entry === "rejected") {
          rejected += 1;
          continue;
        }
        if (document.records.some((record) => record.id === entry.id)) {
          skipped += 1;
          continue;
        }
        if (document.records.length >= MAX_RECORDS) {
          rejected += 1;
          continue;
        }
        const safePaths: string[] = [];
        let pathValid = true;
        for (const associated of entry.paths) {
          try {
            safePaths.push(await validateAssociatedPath(workspace, associated));
          } catch {
            pathValid = false;
            break;
          }
        }
        if (!pathValid) {
          rejected += 1;
          continue;
        }
        document.records.push({
          id: entry.id, kind: entry.kind, content: entry.content, paths: safePaths, createdAt: now,
          ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }), status: "current", evidenceClass: "assertion",
          provenance: {
            origin: "project-memory-mcp/import_memory", writer: stamp.writer, authority: stamp.authority,
            originSurface: stamp.originSurface, stampedAt: now,
          },
        });
        imported += 1;
      }
      if (imported > 0) {
        document.records = this.prune(document.records, now);
        await this.persist(workspace, document, signal);
      }
      return { imported, skipped, rejected, path };
    });
  }

  /**
   * Resolve the portable JSONL path: the explicit argument when given, else the
   * repo-local default. Either way the resolved file must stay inside the
   * workspace, so an agent cannot aim import/export at an arbitrary host path.
   */
  private async resolvePortablePath(workspace: string, explicit?: string): Promise<string> {
    const candidate = explicit === undefined || explicit.trim() === "" ? defaultPortablePath(workspace) : resolve(workspace, explicit);
    const relativeToWorkspace = relative(workspace, candidate);
    if (relativeToWorkspace === ".." || relativeToWorkspace.startsWith(`..${sep}`) || isAbsolute(relativeToWorkspace)) {
      throw new Error("Project memory portable path must stay inside the workspace.");
    }
    await validateAssociatedPath(workspace, relativeToWorkspace);
    return candidate;
  }
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROJECT_MEMORY_DATA_DIR) return resolve(env.PROJECT_MEMORY_DATA_DIR);
  if (env.XDG_DATA_HOME) return join(resolve(env.XDG_DATA_HOME), "project-memory-mcp");
  if (!env.HOME) throw new Error("HOME is required when no project memory data directory is configured.");
  return join(resolve(env.HOME), ".local", "share", "project-memory-mcp");
}
