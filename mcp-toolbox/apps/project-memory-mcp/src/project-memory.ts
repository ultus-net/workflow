import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const MEMORY_KINDS = ["fact", "decision", "constraint", "lesson"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  content: string;
  paths: string[];
  createdAt: number;
  supersedes?: string;
  status: "current" | "superseded";
  evidenceClass: "assertion";
  freshness: "fresh" | "stale";
  provenance: { origin: "project-memory-mcp/record_memory"; workspace: string };
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

interface StoredRecord extends Omit<MemoryRecord, "freshness" | "provenance"> {}
interface StoreDocument { version: 1; workspace: string; records: StoredRecord[] }

const MAX_RECORDS = 1000;
const MAX_STORE_BYTES = 5 * 1024 * 1024;
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

function publicRecord(record: StoredRecord, workspace: string): MemoryRecord {
  return {
    ...record,
    freshness: record.status === "current" ? "fresh" : "stale",
    provenance: { origin: "project-memory-mcp/record_memory", workspace },
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
    && (record.supersedes === undefined || (typeof record.supersedes === "string" && record.supersedes.length > 0 && record.supersedes.length <= 200 && !/[\0\r\n]/.test(record.supersedes)))
    && (record.status === "current" || record.status === "superseded")
    && record.evidenceClass === "assertion";
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

export class ProjectMemoryStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly dataRoot: string) {}

  private pathFor(workspace: string): string {
    return join(this.dataRoot, `${createHash("sha256").update(workspace).digest("hex")}.json`);
  }

  private async load(workspace: string): Promise<StoreDocument> {
    const path = this.pathFor(workspace);
    try {
      const info = await stat(path);
      if (info.size > MAX_STORE_BYTES) throw new Error("Project memory store exceeds its size limit.");
      const raw = await readFile(path, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") throw new Error();
      const document = value as Partial<StoreDocument>;
      if (document.version !== 1 || document.workspace !== workspace || !Array.isArray(document.records) || document.records.length > MAX_RECORDS || !document.records.every(isStoredRecord)) throw new Error();
      return document as StoreDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspace, records: [] };
      if (error instanceof Error && error.message.includes("size limit")) throw error;
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

    let stored!: StoredRecord;
    const previous = this.writes.get(workspace) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      abortIfNeeded(signal);
      const document = await this.load(workspace);
      if (document.records.length >= MAX_RECORDS) throw new Error("Project memory record limit reached.");
      let superseded: StoredRecord | undefined;
      if (input.supersedes) {
        if (input.supersedes.length > 200 || /[\0\r\n]/.test(input.supersedes)) throw new Error("Invalid superseded memory ID.");
        superseded = document.records.find((record) => record.id === input.supersedes && record.status === "current");
        if (!superseded) throw new Error("Superseded memory must identify a current memory in this project.");
      }
      stored = {
        id: randomUUID(), kind: input.kind, content, paths: safePaths, createdAt: Date.now(),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}), status: "current", evidenceClass: "assertion",
      };
      if (superseded) superseded.status = "superseded";
      document.records.push(stored);
      await this.persist(workspace, document, signal);
    });
    this.writes.set(workspace, write);
    try {
      await write;
      return publicRecord(stored, workspace);
    } finally {
      if (this.writes.get(workspace) === write) this.writes.delete(workspace);
    }
  }

  async search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> {
    abortIfNeeded(signal);
    const workspace = await canonicalWorkspace(input.workspaceRoot);
    if (!input.query.trim() || input.query.length > 500) throw new Error("Project memory query must be 1-500 characters.");
    const limit = input.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Project memory search limit must be 1-20.");
    const terms = tokenize(input.query);
    if (terms.length === 0) return { records: [], truncated: false };
    const document = await this.load(workspace);
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
}

export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROJECT_MEMORY_DATA_DIR) return resolve(env.PROJECT_MEMORY_DATA_DIR);
  if (env.XDG_DATA_HOME) return join(resolve(env.XDG_DATA_HOME), "project-memory-mcp");
  if (!env.HOME) throw new Error("HOME is required when no project memory data directory is configured.");
  return join(resolve(env.HOME), ".local", "share", "project-memory-mcp");
}
