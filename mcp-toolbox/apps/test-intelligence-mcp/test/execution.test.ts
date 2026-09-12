import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { NodeTestAdapter } from "../src/node-test-adapter.js";

const fixture = resolve("test/fixtures/node-project");

test("runs explicit JavaScript and TypeScript test IDs with normalized results", async () => {
  const result = await new NodeTestAdapter().runTests({
    workspaceRoot: fixture,
    testIds: ["node:passing.test.js", "node:nested/failing.spec.ts"],
    timeoutMs: 30_000,
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.tests.map(({ name, file, status }) => ({ name, file, status })), [
    { name: "fails", file: "nested/failing.spec.ts", status: "failed" },
    { name: "passes", file: "passing.test.js", status: "passed" },
  ]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.name, "fails");
  assert.match(result.failures[0]?.message ?? "", /fixture failure/);
  assert.equal(result.failuresTruncated, false);
  assert.equal(result.diagnosticsTruncated, false);
});

test("rejects unsupported, missing, and escaped test IDs before execution", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "test-intelligence-run-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "outside.test.js"), "");

  const adapter = new NodeTestAdapter();
  for (const testId of ["other:passing.test.js", "node:missing.test.js", "node:../outside.test.js", "node:src/not-a-test.ts"]) {
    await assert.rejects(adapter.runTests({ workspaceRoot: fixture, testIds: [testId], timeoutMs: 30_000 }));
  }
});

test("treats loader failures without test-case events as execution errors", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-loader-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "broken.test.js"), `import "./missing-module.js";\n`);

  await assert.rejects(
    new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:broken.test.js"], timeoutMs: 30_000 }),
    /without a trustworthy failed-test event/,
  );
});

test("preserves skipped and todo statuses rather than reporting false passes", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-status-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "status.test.js"), `import test from "node:test";\ntest.skip("skipped case", () => {});\ntest.todo("todo case");\n`);

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:status.test.js"], timeoutMs: 30_000 });
  assert.deepEqual(result.tests.map(({ name, status }) => ({ name, status })), [
    { name: "skipped case", status: "skipped" },
    { name: "todo case", status: "todo" },
  ]);
});

test("does not let a passing event mask a later abnormal nonzero runner exit", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-abnormal-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "abnormal.test.js"), `import test from "node:test";\ntest("passes first", () => {});\ntest.after(() => { process.exitCode = 2; });\n`);

  await assert.rejects(
    new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:abnormal.test.js"], timeoutMs: 30_000 }),
    /without a trustworthy failed-test event/,
  );
});

test("does not inherit credential or runtime-injection environment variables", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-env-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(workspace, "environment.test.js"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("sanitized", () => { assert.equal(process.env.TEST_INTELLIGENCE_SECRET, undefined); assert.equal(process.env.NODE_OPTIONS, undefined); });\n`,
  );
  const previousSecret = process.env.TEST_INTELLIGENCE_SECRET;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.TEST_INTELLIGENCE_SECRET = "do-not-inherit";
  process.env.NODE_OPTIONS = "--trace-warnings";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.TEST_INTELLIGENCE_SECRET;
    else process.env.TEST_INTELLIGENCE_SECRET = previousSecret;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  });

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:environment.test.js"], timeoutMs: 30_000 });
  assert.equal(result.tests[0]?.status, "passed");
});

test("bounds failure diagnostics per test and across the execution", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-output-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const huge = "x".repeat(20 * 1024);
  await writeFile(join(workspace, "large.test.js"), `import test from "node:test";\nfor (let i = 0; i < 5; i++) test("failure-" + i, () => { throw new Error(${JSON.stringify(huge)}); });\n`);

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:large.test.js"], timeoutMs: 30_000 });
  assert.equal(result.failures.length, 4);
  assert.equal(result.failuresTruncated, true);
  assert.equal(result.diagnosticsTruncated, true);
  assert.ok(result.failures.every((failure) => Buffer.byteLength(failure.message, "utf8") <= 16 * 1024));
  assert.ok(result.failures.reduce((total, failure) => total + Buffer.byteLength(failure.message, "utf8"), 0) <= 64 * 1024);
});

test("bounds per-test execution records with evidence-based truncation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-results-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "many.test.js"), `import test from "node:test";\nfor (let i = 0; i < 1001; i++) test("case-" + String(i).padStart(4, "0"), () => {});\n`);

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:many.test.js"], timeoutMs: 30_000 });
  assert.equal(result.tests.length, 1000);
  assert.equal(result.testsTruncated, true);
  assert.equal(result.tests.at(-1)?.name, "case-0999");
});

test("bounds test names and reports name truncation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-names-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "name.test.js"), `import test from "node:test";\ntest("x".repeat(5000), () => {});\n`);

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:name.test.js"], timeoutMs: 30_000 });
  assert.equal(Buffer.byteLength(result.tests[0]!.name, "utf8"), 4 * 1024);
  assert.equal(result.tests[0]!.nameTruncated, true);
});

test("normalizes timeout and waits for the direct child to stop", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-timeout-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const marker = join(workspace, "late-marker");
  await writeFile(join(workspace, "hanging.test.js"), `import test from "node:test";\nimport { writeFile } from "node:fs/promises";\ntest("hangs", async () => { setTimeout(() => void writeFile(${JSON.stringify(marker)}, "alive"), 500); await new Promise(() => {}); });\n`);

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:hanging.test.js"], timeoutMs: 50 });
  assert.equal(result.outcome, "timed_out");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("normalizes cancellation and cleans up the direct child", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-cancel-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "hanging.test.js"), `import test from "node:test";\ntest("hangs", async () => { await new Promise(() => {}); });\n`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:hanging.test.js"], timeoutMs: 30_000 }, controller.signal);
  assert.equal(result.outcome, "cancelled");
});

test("kills runner descendants on platforms with process-group termination", { skip: process.platform === "win32" }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "test-intelligence-descendant-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const marker = join(workspace, "descendant-marker");
  await writeFile(
    join(workspace, "descendant.test.js"),
    `import test from "node:test";\nimport { spawn } from "node:child_process";\ntest("spawns", async () => { spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 500)`)}], { stdio: "ignore" }); await new Promise(() => {}); });\n`,
  );

  const result = await new NodeTestAdapter().runTests({ workspaceRoot: workspace, testIds: ["node:descendant.test.js"], timeoutMs: 100 });
  assert.equal(result.outcome, "timed_out");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
