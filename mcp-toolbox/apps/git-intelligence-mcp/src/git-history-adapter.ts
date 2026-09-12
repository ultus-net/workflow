import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface FileHistoryQuery { workspaceRoot: string; path: string; limit: number }
export interface HistoryCommit { commit: string; authorName: string; authorEmail: string; authorTime: string; path: string; originalPath?: string; subject: string; body: string; messageTruncated: boolean }
export interface FileHistoryResult { commits: readonly HistoryCommit[]; truncated: boolean }
export interface FileBlameQuery { workspaceRoot: string; path: string; limit: number }
export interface BlameLine { commit: string; authorName: string; authorEmail: string; authorTime: string; path: string; originalLine: number; finalLine: number }
export interface FileBlameResult { lines: readonly BlameLine[]; truncated: boolean }

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024;

function callerPath(root: string, path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) throw new Error("Git history path escapes workspace");
  if (path.split(sep === "\\" ? /[\\/]/ : "/").includes("..")) throw new Error("Git history path escapes workspace");
  const rel = relative(root, resolve(root, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Git history path escapes workspace");
  return sep === "\\" ? path.replaceAll("\\", "/") : path;
}

function historicalPath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("Malformed Git historical path");
  return path;
}

function parseQuotedGitPath(value: string): string {
  if (!value.startsWith('"')) return historicalPath(value);
  if (!value.endsWith('"')) throw new Error("Malformed quoted Git historical path");
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index]!;
    if (char !== "\\") {
      const codePoint = value.codePointAt(index)!;
      const decoded = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(decoded));
      index += decoded.length - 1;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined || index === value.length - 1) throw new Error("Malformed quoted Git historical path");
    if (escaped in escapes) bytes.push(escapes[escaped]!);
    else if (/[0-7]/.test(escaped)) {
      const octal = value.slice(index, index + 3);
      if (!/^[0-7]{3}$/.test(octal)) throw new Error("Malformed quoted Git historical path");
      bytes.push(Number.parseInt(octal, 8));
      index += 2;
    } else throw new Error("Malformed quoted Git historical path");
  }
  return historicalPath(Buffer.from(bytes).toString("utf8"));
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

function boundMessage(subject: string, body: string): { subject: string; body: string; truncated: boolean } {
  const boundedSubject = truncateUtf8(subject, MAX_MESSAGE_BYTES - 1);
  if (boundedSubject.truncated) return { subject: boundedSubject.text, body: "", truncated: true };
  const separatorBytes = body ? 1 : 0;
  const remaining = Math.max(0, MAX_MESSAGE_BYTES - Buffer.byteLength(subject) - separatorBytes);
  const boundedBody = truncateUtf8(body, remaining);
  return { subject, body: boundedBody.text, truncated: boundedBody.truncated };
}

function runGit(root: string, args: readonly string[], operation: string, signal?: AbortSignal): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
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
      if (signal?.aborted) reject(new Error(`Git ${operation} cancelled`));
      else if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Git ${operation} failed${stderr ? `: ${stderr.trim()}` : ""}`));
      else resolvePromise(Buffer.concat(chunks));
    });
  });
}

async function repositoryRoot(workspaceRoot: string, operation: string, signal?: AbortSignal): Promise<string> {
  const root = await realpath(workspaceRoot);
  const discovered = (await runGit(root, ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.hooksPath=", "rev-parse", "--show-toplevel"], operation, signal)).toString("utf8").trim();
  if (await realpath(discovered) !== root) throw new Error("workspaceRoot must be the Git worktree root");
  return root;
}

async function assertSafeBlameConfig(root: string, signal?: AbortSignal): Promise<void> {
  const output = (await runGit(root, ["--no-pager", "--no-optional-locks", "config", "--null", "--list"], "blame configuration", signal)).toString("utf8");
  for (const record of output.split("\0")) {
    const key = record.slice(0, record.indexOf("\n")).toLowerCase();
    if (key === "diff.external" || /^diff\..+\.textconv$/.test(key) || key === "blame.ignorerevsfile") {
      throw new Error(`Git blame refuses configured executable or attribution behavior: ${key}`);
    }
  }
}

function parseHistory(output: Buffer): HistoryCommit[] {
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) !== "") throw new Error("Malformed NUL-delimited Git history output");
  records.pop();
  const commits: HistoryCommit[] = [];
  for (let index = 0; index < records.length;) {
    if (records.length - index < 7) throw new Error("Malformed Git history metadata");
    const commit = records[index++]!.replace(/^\n/, "");
    const authorName = records[index++]!;
    const authorEmail = records[index++]!;
    const authorTime = records[index++]!;
    const subject = records[index++]!;
    const body = records[index++]!;
    if (records[index++] !== "") throw new Error("Malformed Git history record separator");
    const status = records[index++]!.replace(/^\n/, "");
    const code = status[0];
    let path: string;
    let originalPath: string | undefined;
    if (code === "R" || code === "C") {
      originalPath = historicalPath(records[index++] ?? "");
      path = historicalPath(records[index++] ?? "");
    } else path = historicalPath(records[index++] ?? "");
    const message = boundMessage(subject, body);
    commits.push({ commit, authorName, authorEmail, authorTime, path, originalPath, subject: message.subject, body: message.body, messageTruncated: message.truncated });
  }
  return commits;
}

function parseBlame(output: Buffer): BlameLine[] {
  const text = output.toString("utf8");
  const lines = text.split("\n");
  const result: BlameLine[] = [];
  for (let index = 0; index < lines.length;) {
    if (!lines[index]) { index++; continue; }
    const header = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(lines[index++]!);
    if (!header) throw new Error("Malformed Git blame header");
    let authorName: string | undefined;
    let authorEmail: string | undefined;
    let authorTime: string | undefined;
    let path: string | undefined;
    for (; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.startsWith("\t")) { index++; break; }
      if (line.startsWith("author ")) authorName = line.slice(7);
      else if (line.startsWith("author-mail <") && line.endsWith(">")) authorEmail = line.slice(13, -1);
      else if (line.startsWith("author-time ")) authorTime = line.slice(12);
      else if (line.startsWith("filename ")) path = parseQuotedGitPath(line.slice(9));
    }
    if (authorName === undefined || authorEmail === undefined || authorTime === undefined || path === undefined) throw new Error("Malformed Git blame metadata");
    result.push({ commit: header[1]!, originalLine: Number(header[2]), finalLine: Number(header[3]), authorName, authorEmail, authorTime, path });
  }
  return result;
}

export class GitHistoryAdapter {
  async fileHistory(query: FileHistoryQuery, signal?: AbortSignal): Promise<FileHistoryResult> {
    if (signal?.aborted) throw new Error("Git history cancelled");
    const root = await repositoryRoot(query.workspaceRoot, "history", signal);
    const path = callerPath(root, query.path);
    const args = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.hooksPath=", "-c", "log.showSignature=false", "-c", "log.follow=false", "log", "--follow", "--no-ext-diff", "--no-textconv", "--no-mailmap", "--encoding=UTF-8", `--max-count=${query.limit + 1}`, "--format=%H%x00%an%x00%ae%x00%at%x00%s%x00%b%x00", "--name-status", "-z", "--", path];
    const commits = parseHistory(await runGit(root, args, "history", signal));
    return { commits: commits.slice(0, query.limit), truncated: commits.length > query.limit };
  }

  async fileBlame(query: FileBlameQuery, signal?: AbortSignal): Promise<FileBlameResult> {
    if (signal?.aborted) throw new Error("Git blame cancelled");
    const root = await repositoryRoot(query.workspaceRoot, "blame", signal);
    const path = callerPath(root, query.path);
    await assertSafeBlameConfig(root, signal);
    const args = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.hooksPath=", "blame", "--line-porcelain", "--root", "--encoding=UTF-8", "--diff-algorithm=myers", `-L1,+${query.limit + 1}`, "HEAD", "--", path];
    let output: Buffer;
    try {
      output = await runGit(root, args, "blame", signal);
    } catch (error) {
      if (error instanceof Error && /fatal: file .* has only 0 lines$/s.test(error.message)) return { lines: [], truncated: false };
      throw error;
    }
    const lines = parseBlame(output);
    return { lines: lines.slice(0, query.limit), truncated: lines.length > query.limit };
  }
}
