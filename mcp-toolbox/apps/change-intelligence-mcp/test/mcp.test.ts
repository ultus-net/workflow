import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client;
const here = dirname(fileURLToPath(import.meta.url));

before(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.CHANGE_INTELLIGENCE_GIT_COMMAND = process.execPath;
  env.CHANGE_INTELLIGENCE_GIT_ARGS = JSON.stringify(["--import", "tsx", resolve(here, "../../git-intelligence-mcp/src/server.ts")]);
  env.CHANGE_INTELLIGENCE_TEST_COMMAND = process.execPath;
  env.CHANGE_INTELLIGENCE_TEST_ARGS = JSON.stringify(["--import", "tsx", resolve(here, "../../test-intelligence-mcp/src/server.ts")]);
  env.CHANGE_INTELLIGENCE_CODE_COMMAND = process.execPath;
  env.CHANGE_INTELLIGENCE_CODE_ARGS = JSON.stringify(["--import", "tsx", resolve(here, "../../code-intelligence-mcp/src/server.ts")]);
  client = new Client({ name: "change-intelligence-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), env, stderr: "pipe" }));
});

after(async () => client.close());

test("exposes one bounded assessment tool with explicit optional test execution", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "change-intelligence-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["assess_local_change"]);
  assert.ok(tools[0]?.outputSchema);
  assert.match(tools[0]?.description ?? "", /Proactively call after meaningful local edits/);
  assert.match(tools[0]?.description ?? "", /only executed when runRelevantTests is explicitly true/);
  assert.deepEqual(tools[0]?.annotations, { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true });
});

test("composes real Git status and structural test relevance through MCP", async () => {
  const root = mkdtempSync(join(tmpdir(), "change-intelligence-mcp-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src/**/*.ts", "test/**/*.ts"] }));
    writeFileSync(join(root, "src", "widget.ts"), "export const widget = 1;\n");
    writeFileSync(join(root, "test", "widget.test.ts"), "import { test } from 'node:test';\ntest('widget', () => {});\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(join(root, "src", "widget.ts"), "export const widget = 2;\n");

    const result = await client.callTool({ name: "assess_local_change", arguments: { workspaceRoot: root, pathLimit: 10, testLimit: 10 } });

    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, {
      paths: [{
        path: "src/widget.ts",
        staged: "none",
        unstaged: "modified",
        source: { capability: "git.working_tree_status", id: "src/widget.ts" },
        relevantTests: [{
          id: "node:test/widget.test.ts",
          file: "test/widget.test.ts",
          relevance: "matching_stem",
          source: { capability: "test.find_relevant_tests", id: "node:test/widget.test.ts" },
        }],
        testsTruncated: false,
        affectedSymbols: [{
          name: "widget", kind: "const", file: "src/widget.ts", line: 1, column: 14, endLine: 1, endColumn: 24,
          sources: [
            { capability: "git.working_tree_status", id: "src/widget.ts" },
            { capability: "git.local_diff", id: "unstaged:src/widget.ts" },
            { capability: "code.document_symbols", id: "src/widget.ts:1:14:widget" },
          ],
          consumers: [],
          consumersTruncated: false,
        }],
        symbolsTruncated: false,
      }],
      pathsTruncated: false,
      incomplete: false,
      testRun: null,
      verificationGaps: [{ kind: "relevant_tests_not_run", testId: "node:test/widget.test.ts", file: "test/widget.test.ts", sources: [{ capability: "git.working_tree_status", id: "src/widget.ts" }, { capability: "test.find_relevant_tests", id: "node:test/widget.test.ts" }] }],
      recommendedChecks: [{ kind: "run_test", testId: "node:test/widget.test.ts", file: "test/widget.test.ts", sources: [{ capability: "git.working_tree_status", id: "src/widget.ts" }, { capability: "test.find_relevant_tests", id: "node:test/widget.test.ts" }] }],
      recommendationsTruncated: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executes bounded relevant tests only with explicit opt-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "change-intelligence-run-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src/**/*.ts", "test/**/*.ts"] }));
    writeFileSync(join(root, "src", "widget.ts"), "export const widget = 1;\n");
    writeFileSync(join(root, "test", "widget.test.ts"), "import { test } from 'node:test';\ntest('widget', () => {});\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(join(root, "src", "widget.ts"), "export const widget = 2;\n");

    const result = await client.callTool({ name: "assess_local_change", arguments: { workspaceRoot: root, runRelevantTests: true, recommendationLimit: 1 } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const content = result.structuredContent as any;
    assert.equal(content.testRun?.outcome, "completed");
    assert.equal(content.testRun?.tests?.some((entry: any) => entry.status === "passed"), true);
    assert.equal(content.verificationGaps.some((gap: any) => gap.kind === "relevant_tests_not_run"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates public assessment bounds", async () => {
  for (const arguments_ of [
    { workspaceRoot: "relative" },
    { workspaceRoot: process.cwd(), pathLimit: 0 },
    { workspaceRoot: process.cwd(), testLimit: 101 },
  ]) {
    const result = await client.callTool({ name: "assess_local_change", arguments: arguments_ });
    assert.equal(result.isError, true);
  }
});

test("emits MCP log and progress notifications for tool calls", async () => {
  const { LoggingMessageNotificationSchema, ProgressNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const logs: { level: string; data: { tool?: string; phase?: string } }[] = [];
  const progress: { message?: string }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { logs.push(notification.params as never); });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => { progress.push(notification.params as never); });

  await client.callTool({ name: "assess_local_change", arguments: { workspaceRoot: process.cwd(), pathLimit: 1, testLimit: 1 }, _meta: { progressToken: "rollout-probe" } });

  assert.ok(logs.some((log) => log.level === "debug" && log.data.phase === "start"), "expected debug start log, got " + JSON.stringify(logs));
  assert.ok(
    logs.some((log) => (log.level === "info" && log.data.phase === "done") || (log.level === "error" && log.data.phase === "error")),
    "expected done or error log, got " + JSON.stringify(logs),
  );
  assert.equal(progress[0]?.message, "start");
});
