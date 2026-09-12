import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export interface ProjectContextCandidate {
  path: string;
  precedence: number;
  snippet: string;
  snippetTruncated: boolean;
  trust: "untrusted_repository_content";
}

export interface DiscoverProjectContextInput { workspaceRoot: string; limit?: number }

const DIRECT_SOURCES = ["TODO.md", "ROADMAP.md", "PLAN.md", "TASKS.md", "BACKLOG.md"] as const;
const MAX_SNIPPET_BYTES = 4096;
const MAX_PLAN_ENTRIES = 100;

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function readSource(root: string, path: string): Promise<{ snippet: string; snippetTruncated: boolean } | undefined> {
  let handle;
  try {
    const sourcePath = join(root, path);
    handle = await open(sourcePath, "r");
    const openedStat = await handle.stat();
    const canonical = await realpath(sourcePath);
    if (!inside(root, canonical)) throw new Error(`Project context source ${path} escapes the workspace.`);
    const canonicalStat = await stat(canonical);
    if (openedStat.dev !== canonicalStat.dev || openedStat.ino !== canonicalStat.ino) throw new Error(`Project context source ${path} changed during discovery.`);
    if (!openedStat.isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_SNIPPET_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > MAX_SNIPPET_BYTES;
    let end = Math.min(bytesRead, MAX_SNIPPET_BYTES);
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return { snippet: buffer.subarray(0, end).toString("utf8"), snippetTruncated: truncated };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

export async function discoverProjectContext(input: DiscoverProjectContextInput, signal?: AbortSignal): Promise<{ candidates: ProjectContextCandidate[]; truncated: boolean }> {
  if (signal?.aborted) throw new Error("Project context discovery cancelled.");
  if (!isAbsolute(input.workspaceRoot)) throw new Error("Workspace root must be absolute.");
  const limit = input.limit ?? 8; if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Project context limit must be 1-20.");
  const root = await realpath(input.workspaceRoot); if (!(await stat(root)).isDirectory()) throw new Error("Workspace root must be a directory.");
  const sources: Array<{ path: string; snippet: string; snippetTruncated: boolean }> = [];
  for (const path of DIRECT_SOURCES) { const content = await readSource(root, path); if (content) sources.push({ path, ...content }); }
  try {
    const planDirectory = await realpath(join(root, "docs", "plans"));
    if (!inside(root, planDirectory)) throw new Error("Project plan directory escapes the workspace.");
    const directory = await opendir(planDirectory); const names: string[] = [];
    try {
      for await (const entry of directory) {
        if (names.length === MAX_PLAN_ENTRIES) throw new Error("Project plan directory exceeds its discovery bound.");
        names.push(entry.name);
      }
    } finally { await directory.close().catch(() => undefined); }
    names.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    for (const name of names.filter((value) => value.toLowerCase().endsWith(".md"))) {
      const path = `docs/plans/${name}`; const content = await readSource(root, path); if (content) sources.push({ path, ...content });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (signal?.aborted) throw new Error("Project context discovery cancelled.");
  const selected = sources.slice(0, limit); const candidates: ProjectContextCandidate[] = [];
  for (const [index, source] of selected.entries()) candidates.push({ ...source, precedence: index + 1, trust: "untrusted_repository_content" });
  return { candidates, truncated: sources.length > limit };
}
