import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type DiffScope = "staged" | "unstaged";
export type DiffChange = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unmerged";
export interface DiffFile { path: string; originalPath?: string; change: DiffChange; binary: boolean; additions?: number; deletions?: number; patch?: string; patchTruncated: boolean }
export interface DiffQuery { workspaceRoot: string; scope: DiffScope; limit: number }
export interface DiffResult { files: readonly DiffFile[]; truncated: boolean; evidenceTruncated: boolean }

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_BYTES = 32 * 1024;
const MAX_TOTAL_PATCH_BYTES = 256 * 1024;

function confinedPath(root: string, path: string): string {
  if (!path || path.includes("\0")) throw new Error("Malformed Git diff path");
  const rel = relative(root, resolve(root, path));
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Git diff path escapes workspace");
  return sep === "\\" ? path.replaceAll("\\", "/") : path;
}

function change(code: string): DiffChange {
  const values: Record<string, DiffChange> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed", U: "unmerged" };
  const value = values[code];
  if (!value) throw new Error(`Unsupported Git diff code: ${code}`);
  return value;
}

function diffArgs(scope: DiffScope): string[] {
  return ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.hooksPath=", "diff", ...(scope === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--ignore-submodules=dirty"];
}

function runGit(root: string, args: readonly string[], operation: string, signal?: AbortSignal): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failed: Error | undefined;
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES && !failed) { failed = new Error(`Git ${operation} output exceeds safety limit`); child.kill(); }
      else if (!failed) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { failed = error; });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Git diff cancelled"));
      else if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Git ${operation} failed${stderr ? `: ${stderr.trim()}` : ""}`));
      else resolvePromise(Buffer.concat(chunks));
    });
  });
}

function parseRaw(root: string, output: Buffer): DiffFile[] {
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) !== "") throw new Error("Malformed NUL-delimited Git diff output");
  records.pop();
  const files: DiffFile[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const fields = record.startsWith(":") ? record.slice(1).split(" ") : [];
    if (fields.length !== 5) throw new Error("Malformed Git raw diff record");
    const status = fields[4]!;
    const first = records[++index];
    if (first === undefined) throw new Error("Malformed Git diff path");
    const firstPath = confinedPath(root, first);
    if (status[0] === "R" || status[0] === "C") {
      const destination = records[++index];
      if (destination === undefined) throw new Error("Malformed Git diff path pair");
      files.push({ path: confinedPath(root, destination), originalPath: firstPath, change: change(status[0]!), binary: false, patchTruncated: false });
    } else files.push({ path: firstPath, change: change(status[0]!), binary: false, patchTruncated: false });
  }
  return files;
}

function applyNumstat(root: string, files: DiffFile[], output: Buffer): void {
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) !== "") throw new Error("Malformed NUL-delimited Git numstat output");
  records.pop();
  for (let index = 0; index < records.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(records[index]!);
    if (!match) throw new Error("Malformed Git numstat record");
    let path = match[3]!;
    if (!path) {
      const original = records[++index];
      const destination = records[++index];
      if (original === undefined || destination === undefined) throw new Error("Malformed Git numstat path pair");
      path = destination;
    }
    const file = files.find((candidate) => candidate.path === confinedPath(root, path));
    if (!file) throw new Error("Git diff metadata mismatch");
    file.binary = match[1] === "-" || match[2] === "-";
    if (!file.binary) { file.additions = Number(match[1]); file.deletions = Number(match[2]); }
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

export class GitDiffAdapter {
  async diff(query: DiffQuery, signal?: AbortSignal): Promise<DiffResult> {
    if (signal?.aborted) throw new Error("Git diff cancelled");
    const root = await realpath(query.workspaceRoot);
    const discovered = (await runGit(root, ["--no-pager", "rev-parse", "--show-toplevel"], "repository discovery", signal)).toString("utf8").trim();
    if (await realpath(discovered) !== root) throw new Error("workspaceRoot must be the Git worktree root");
    const args = diffArgs(query.scope);
    const files = parseRaw(root, await runGit(root, [...args, "--raw", "-z"], "diff", signal));
    applyNumstat(root, files, await runGit(root, [...args, "--numstat", "-z"], "diff", signal));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const returned = files.slice(0, query.limit);
    let remainingBytes = MAX_TOTAL_PATCH_BYTES;
    let evidenceTruncated = false;
    for (const file of returned) {
      if (file.binary) continue;
      const paths = file.originalPath ? [file.originalPath, file.path] : [file.path];
      const patch = (await runGit(root, [...args, "--patch", "--full-index", "--unified=3", "--inter-hunk-context=0", "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", "--", ...paths], "diff", signal)).toString("utf8");
      const bounded = truncateUtf8(patch, Math.min(MAX_PATCH_BYTES, remainingBytes));
      file.patch = bounded.text;
      file.patchTruncated = bounded.truncated;
      remainingBytes -= Buffer.byteLength(bounded.text);
      evidenceTruncated ||= bounded.truncated;
    }
    return { files: returned, truncated: files.length > query.limit, evidenceTruncated };
  }
}
