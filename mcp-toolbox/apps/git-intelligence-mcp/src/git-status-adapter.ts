import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type ChangeState = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unmerged" | "untracked" | "none";

export interface StatusEntry {
  path: string;
  originalPath?: string;
  staged: ChangeState;
  unstaged: ChangeState;
  conflict?: "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU";
}

export interface WorkingTreeStatusQuery { workspaceRoot: string; limit: number }
export interface WorkingTreeStatusResult { entries: readonly StatusEntry[]; truncated: boolean }

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const conflicts = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function state(code: string): ChangeState {
  const states: Record<string, ChangeState> = { ".": "none", " ": "none", A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed" };
  const value = states[code];
  if (!value) throw new Error(`Unsupported Git status code: ${code}`);
  return value;
}

function confinedPath(root: string, path: string): string {
  if (!path || path.includes("\0")) throw new Error("Malformed Git status path");
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
    if (rel !== "") throw new Error("Git status path escapes workspace");
  }
  return path.replaceAll("\\", "/");
}

function parseStatus(root: string, output: Buffer): StatusEntry[] {
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) !== "") throw new Error("Malformed NUL-delimited Git status output");
  records.pop();
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      entries.push({ path: confinedPath(root, record.slice(2)), staged: "none", unstaged: "untracked" });
      continue;
    }
    if (record.startsWith("! ")) continue;
    const fields = record.split(" ");
    if (record.startsWith("1 ")) {
      if (fields.length < 9) throw new Error("Malformed ordinary Git status record");
      const xy = fields[1]!;
      entries.push({ path: confinedPath(root, fields.slice(8).join(" ")), staged: state(xy[0]!), unstaged: state(xy[1]!) });
      continue;
    }
    if (record.startsWith("2 ")) {
      if (fields.length < 10) throw new Error("Malformed renamed Git status record");
      const xy = fields[1]!;
      const original = records[++index];
      if (original === undefined) throw new Error("Malformed renamed Git status path pair");
      entries.push({ path: confinedPath(root, fields.slice(9).join(" ")), originalPath: confinedPath(root, original), staged: state(xy[0]!), unstaged: state(xy[1]!) });
      continue;
    }
    if (record.startsWith("u ")) {
      if (fields.length < 11 || !conflicts.has(fields[1]!)) throw new Error("Unsupported Git conflict status");
      entries.push({ path: confinedPath(root, fields.slice(10).join(" ")), staged: "unmerged", unstaged: "unmerged", conflict: fields[1] as StatusEntry["conflict"] });
      continue;
    }
    throw new Error("Unsupported Git status record");
  }
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.originalPath ?? "") < (b.originalPath ?? "") ? -1 : (a.originalPath ?? "") > (b.originalPath ?? "") ? 1 : 0);
}

async function statusOutput(root: string, signal?: AbortSignal): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
  const args = [
    "--no-pager", "--no-optional-locks",
    "-c", "core.fsmonitor=false", "-c", "status.renames=true",
    "-c", "credential.helper=", "-c", "core.hooksPath=",
    "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty",
  ];
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failed: Error | undefined;
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES && !failed) {
        failed = new Error("Git status output exceeds safety limit");
        child.kill();
      } else if (!failed) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { failed = error; });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Git status cancelled"));
      else if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Git status failed${stderr ? `: ${stderr.trim()}` : ""}`));
      else resolvePromise(Buffer.concat(chunks));
    });
  });
}

export class GitStatusAdapter {
  async workingTreeStatus(query: WorkingTreeStatusQuery, signal?: AbortSignal): Promise<WorkingTreeStatusResult> {
    if (signal?.aborted) throw new Error("Git status cancelled");
    const root = await realpath(query.workspaceRoot);
    const discovered = (await this.gitRoot(root, signal)).trim();
    if (await realpath(discovered) !== root) throw new Error("workspaceRoot must be the Git worktree root");
    const entries = parseStatus(root, await statusOutput(root, signal));
    return { entries: entries.slice(0, query.limit), truncated: entries.length > query.limit };
  }

  private async gitRoot(root: string, signal?: AbortSignal): Promise<string> {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
    return await new Promise((resolvePromise, reject) => {
      const child = spawn("git", ["--no-pager", "rev-parse", "--show-toplevel"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failed: Error | undefined;
      let stderr = "";
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096 && !failed) {
          failed = new Error("Git repository discovery output exceeds safety limit");
          child.kill();
        } else if (!failed) chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
      child.on("error", (error) => { failed = error; });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(new Error("Git status cancelled"));
        else if (failed) reject(failed);
        else if (code !== 0) reject(new Error(`Git repository discovery failed${stderr ? `: ${stderr.trim()}` : ""}`));
        else resolvePromise(Buffer.concat(chunks).toString("utf8"));
      });
    });
  }
}
