import { spawn } from "node:child_process";
import { opendir, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import type { DiscoverTestsQuery, DiscoverTestsResult, FindRelevantTestsQuery, FindRelevantTestsResult, RelevantTestDescriptor, RunTestsQuery, RunTestsResult, TestDescriptor, TestExecution, TestFailure } from "./test-adapter.js";

const testFilePattern = /\.(?:test|spec)\.(?:js|cjs|mjs|ts|cts|mts)$/;
const excludedDirectories = new Set([".git", "node_modules"]);
const typescriptTestFilePattern = /\.(?:ts|cts|mts)$/;
const allowedEnvironment = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;
const MAX_FAILURES = 100;
const MAX_TEST_RESULTS = 1000;
const MAX_TOTAL_FAILURE_BYTES = 64 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExcludedDirectory(file: string): boolean {
  return file.split("/").some((part) => excludedDirectories.has(part));
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowedEnvironment) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true };
}

async function nearestPackageRoot(root: string, file: string): Promise<string | undefined> {
  let directory = dirname(file);
  while (isInside(root, directory)) {
    try {
      if ((await stat(resolve(directory, "package.json"))).isFile()) return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
}

function sourceStem(file: string): string {
  const name = basename(file);
  return name.slice(0, -extname(name).length);
}

function testStem(file: string): string {
  return basename(file).replace(/\.(?:test|spec)\.(?:js|cjs|mjs|ts|cts|mts)$/, "");
}

interface ReporterEvent {
  type: "test:pass" | "test:fail";
  name: string;
  nameTruncated: boolean;
  file?: string;
  nesting: number;
  durationMs: number;
  detailType?: string;
  skip: boolean;
  todo: boolean;
  message?: string;
  messageTruncated: boolean;
}

function compareReporterEvent(left: ReporterEvent, right: ReporterEvent): number {
  return compareOrdinal(left.file ?? "", right.file ?? "") || compareOrdinal(left.name, right.name);
}

export class NodeTestAdapter {
  async discoverTests(query: DiscoverTestsQuery, signal?: AbortSignal): Promise<DiscoverTestsResult> {
    throwIfAborted(signal);
    const root = await realpath(query.workspaceRoot);
    const discovered = new Map<string, TestDescriptor>();
    const directories = [root];

    while (directories.length > 0) {
      throwIfAborted(signal);
      const directory = directories.pop()!;
      const entries = await opendir(directory);
      for await (const entry of entries) {
        throwIfAborted(signal);
        if (entry.isDirectory()) {
          if (!excludedDirectories.has(entry.name)) directories.push(resolve(directory, entry.name));
          continue;
        }
        if ((!entry.isFile() && !entry.isSymbolicLink()) || !testFilePattern.test(entry.name)) continue;

        let canonicalFile: string;
        try {
          canonicalFile = await realpath(resolve(directory, entry.name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const file = relative(root, canonicalFile).split(sep).join("/");
        throwIfAborted(signal);
        if (!isInside(root, canonicalFile) || discovered.has(canonicalFile) || hasExcludedDirectory(file) || !testFilePattern.test(file)) continue;
        if (!(await stat(canonicalFile)).isFile()) continue;
        discovered.set(canonicalFile, { id: `node:${file}`, file, label: file, runner: "node" });
      }
    }

    throwIfAborted(signal);
    const ordered = [...discovered.values()].sort((left, right) => compareOrdinal(left.file, right.file) || compareOrdinal(left.id, right.id));
    return { tests: ordered.slice(0, query.limit), truncated: ordered.length > query.limit };
  }

  async findRelevantTests(query: FindRelevantTestsQuery, signal?: AbortSignal): Promise<FindRelevantTestsResult> {
    throwIfAborted(signal);
    const root = await realpath(query.workspaceRoot);
    if (!query.file || query.file.includes("\\") || query.file.startsWith("/") || query.file.split("/").includes("..")) {
      throw new Error("file must be a workspace-relative path without parent traversal");
    }
    const source = await realpath(resolve(root, query.file));
    if (!isInside(root, source) || !(await stat(source)).isFile()) throw new Error("file must identify a file inside the workspace");
    const projectRoot = await nearestPackageRoot(root, source);
    if (!projectRoot) throw new Error("No package.json project contains the requested file");

    const discovered = await this.discoverTests({ workspaceRoot: projectRoot, limit: Number.MAX_SAFE_INTEGER }, signal);
    const relevant: RelevantTestDescriptor[] = [];
    const stem = sourceStem(source);
    for (const test of discovered.tests) {
      throwIfAborted(signal);
      const canonicalTest = await realpath(resolve(projectRoot, test.file));
      if ((await nearestPackageRoot(root, canonicalTest)) !== projectRoot) continue;
      const file = relative(root, canonicalTest).split(sep).join("/");
      const descriptor: TestDescriptor = { id: `node:${file}`, file, label: file, runner: "node" };
      const relevance: RelevantTestDescriptor["relevance"] = canonicalTest === source
        ? "exact_file"
        : testStem(file) === stem
          ? "matching_stem"
          : "same_project";
      relevant.push({ ...descriptor, relevance });
    }
    const rank = { exact_file: 0, matching_stem: 1, same_project: 2 } as const;
    relevant.sort((left, right) => rank[left.relevance] - rank[right.relevance] || compareOrdinal(left.file, right.file));
    return { tests: relevant.slice(0, query.limit), truncated: relevant.length > query.limit };
  }

  async runTests(query: RunTestsQuery, signal?: AbortSignal): Promise<RunTestsResult> {
    if (!Number.isInteger(query.timeoutMs) || query.timeoutMs < 1 || query.timeoutMs > 300_000) throw new Error("timeoutMs must be an integer from 1 to 300000");
    if (query.testIds.length === 0 || query.testIds.length > 500) throw new Error("testIds must contain between 1 and 500 IDs");
    if (signal?.aborted) return { outcome: "cancelled", exitCode: null, tests: [], testsTruncated: false, failures: [], failuresTruncated: false, diagnosticsTruncated: false };
    const root = await realpath(query.workspaceRoot);
    const files: string[] = [];
    for (const id of query.testIds) {
      if (!id.startsWith("node:")) throw new Error(`Unsupported test ID: ${id}`);
      const requestedFile = id.slice("node:".length);
      if (!requestedFile || requestedFile.includes("\\") || requestedFile.startsWith("/") || requestedFile.split("/").includes("..")) {
        throw new Error(`Invalid test ID: ${id}`);
      }
      const canonicalFile = await realpath(resolve(root, requestedFile));
      const file = relative(root, canonicalFile).split(sep).join("/");
      if (!isInside(root, canonicalFile) || hasExcludedDirectory(file) || !testFilePattern.test(file) || `node:${file}` !== id) {
        throw new Error(`Test ID is not executable in this workspace: ${id}`);
      }
      if (!(await stat(canonicalFile)).isFile()) throw new Error(`Test ID does not identify a file: ${id}`);
      if (!files.includes(canonicalFile)) files.push(canonicalFile);
    }

    if (signal?.aborted) return { outcome: "cancelled", exitCode: null, tests: [], testsTruncated: false, failures: [], failuresTruncated: false, diagnosticsTruncated: false };
    const reporter = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "node-test-reporter.js");
    const args = ["--test", `--test-reporter=${reporter}`];
    if (files.some((file) => typescriptTestFilePattern.test(file))) args.push("--import", import.meta.resolve("tsx"));
    args.push("--", ...files);

    const testEvents: ReporterEvent[] = [];
    const failureEvents: ReporterEvent[] = [];
    let testEventCount = 0;
    let failureEventCount = 0;
    let sawTrustworthyFailure = false;
    let stdoutBuffer = "";
    let stderr = "";
    let outcome: RunTestsResult["outcome"] = "completed";
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: sanitizedEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          const event = JSON.parse(line) as ReporterEvent;
          const isTestEvent = event.detailType !== "suite" && event.file !== undefined && event.name !== event.file && files.includes(event.file);
          if (isTestEvent) {
            testEventCount += 1;
            testEvents.push(event);
            testEvents.sort(compareReporterEvent);
            if (testEvents.length > MAX_TEST_RESULTS) testEvents.pop();
            if (event.type === "test:fail" && !event.todo && !event.skip) {
              sawTrustworthyFailure = true;
              failureEventCount += 1;
              failureEvents.push(event);
              failureEvents.sort(compareReporterEvent);
              if (failureEvents.length > MAX_FAILURES) failureEvents.pop();
            }
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < 16 * 1024) stderr = truncateUtf8(stderr + chunk, 16 * 1024).text;
    });

    let forceKill: Promise<void> | undefined;
    const terminate = (reason: "timed_out" | "cancelled") => {
      if (outcome !== "completed") return;
      outcome = reason;
      const kill = (signalName: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signalName);
          else child.kill(signalName);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      kill("SIGTERM");
      forceKill = new Promise((resolveForceKill) => {
        setTimeout(() => {
          kill("SIGKILL");
          resolveForceKill();
        }, 250);
      });
    };
    const timeout = setTimeout(() => terminate("timed_out"), query.timeoutMs);
    timeout.unref();
    const onAbort = () => terminate("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", resolveExit);
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    if (forceKill) await forceKill;

    if (outcome !== "completed") return { outcome, exitCode, tests: [], testsTruncated: false, failures: [], failuresTruncated: false, diagnosticsTruncated: false };

    if (exitCode !== 0 && !sawTrustworthyFailure) {
      throw new Error(`Node test runner exited without a trustworthy failed-test event${stderr ? `: ${stderr}` : ""}`);
    }
    const tests: TestExecution[] = [];
    const failures: TestFailure[] = [];
    let totalFailureBytes = 0;
    let failuresTruncated = failureEventCount > MAX_FAILURES;
    let diagnosticsTruncated = false;
    for (const event of testEvents) {
      const file = relative(root, event.file!).split(sep).join("/");
      const status: TestExecution["status"] = event.todo ? "todo" : event.skip ? "skipped" : event.type === "test:pass" ? "passed" : "failed";
      tests.push({ name: event.name, nameTruncated: event.nameTruncated, file, status, durationMs: event.durationMs });
    }
    for (const event of failureEvents) {
      const file = relative(root, event.file!).split(sep).join("/");
      const remaining = MAX_TOTAL_FAILURE_BYTES - totalFailureBytes;
      if (remaining <= 0) {
        failuresTruncated = true;
        diagnosticsTruncated = true;
        continue;
      }
      const bounded = truncateUtf8(event.message ?? event.name, remaining);
      const truncated = event.messageTruncated || bounded.truncated;
      failures.push({ name: event.name, nameTruncated: event.nameTruncated, file, message: bounded.text, truncated });
      totalFailureBytes += Buffer.byteLength(bounded.text, "utf8");
      diagnosticsTruncated ||= truncated;
    }
    tests.sort((left, right) => compareOrdinal(left.file, right.file) || compareOrdinal(left.name, right.name));
    failures.sort((left, right) => compareOrdinal(left.file, right.file) || compareOrdinal(left.name, right.name));
    diagnosticsTruncated ||= failuresTruncated;
    return { outcome, exitCode, tests, testsTruncated: testEventCount > MAX_TEST_RESULTS, failures, failuresTruncated, diagnosticsTruncated };
  }
}
