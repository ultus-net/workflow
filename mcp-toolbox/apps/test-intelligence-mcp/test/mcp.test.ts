import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectCompiledStdioClient } from "../../../packages/test-support/mcp-client.ts";

let client: Client;

before(async () => {
  client = await connectCompiledStdioClient("test-intelligence-black-box-test");
});

after(async () => client.close());

test("initializes the compiled stdio server and exposes discovery, relevance, and execution", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "test-intelligence-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["discover_tests", "find_relevant_tests", "run_tests"]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  assert.deepEqual(tools.find((tool) => tool.name === "run_tests")?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("returns bounded structural file relevance through the compiled MCP server", async () => {
  const result = await client.callTool({
    name: "find_relevant_tests",
    arguments: { workspaceRoot: process.cwd(), file: "test/discovery.test.ts", limit: 1 },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    tests: [{ id: "node:test/discovery.test.ts", file: "test/discovery.test.ts", label: "test/discovery.test.ts", runner: "node", relevance: "exact_file" }],
    truncated: true,
  });
});

test("validates public relevance paths and limits", async () => {
  for (const arguments_ of [
    { workspaceRoot: process.cwd(), file: "../package.json", limit: 1 },
    { workspaceRoot: process.cwd(), file: "src/node-test-adapter.ts", limit: 0 },
    { workspaceRoot: "relative", file: "src/node-test-adapter.ts", limit: 1 },
  ]) {
    const result = await client.callTool({ name: "find_relevant_tests", arguments: arguments_ });
    assert.equal(result.isError, true);
  }
});

test("returns normal test failures as structured successful execution results", async () => {
  const result = await client.callTool({
    name: "run_tests",
    arguments: {
      workspaceRoot: resolve("test/fixtures/node-project"),
      testIds: ["node:passing.test.js", "node:nested/failing.spec.ts"],
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual((result.structuredContent as { tests: Array<{ name: string; status: string }> }).tests.map(({ name, status }) => ({ name, status })), [
    { name: "fails", status: "failed" },
    { name: "passes", status: "passed" },
  ]);
  assert.equal((result.structuredContent as { exitCode: number }).exitCode, 1);
});

test("validates execution bounds and surfaces invalid test IDs as tool errors", async () => {
  for (const arguments_ of [
    { workspaceRoot: "relative", testIds: ["node:passing.test.js"] },
    { workspaceRoot: fixtureRoot(), testIds: [], timeoutMs: 100 },
    { workspaceRoot: fixtureRoot(), testIds: ["node:passing.test.js"], timeoutMs: 0 },
    { workspaceRoot: fixtureRoot(), testIds: ["node:missing.test.js"], timeoutMs: 100 },
  ]) {
    const result = await client.callTool({ name: "run_tests", arguments: arguments_ });
    assert.equal(result.isError, true);
  }
});

test("discovers bounded runnable files through the compiled MCP server", async () => {
  const result = await client.callTool({
    name: "discover_tests",
    arguments: { workspaceRoot: resolve("test/fixtures/node-project"), limit: 1 },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    tests: [{ id: "node:nested/failing.spec.ts", file: "nested/failing.spec.ts", label: "nested/failing.spec.ts", runner: "node" }],
    truncated: true,
  });
});

test("validates public discovery limits and absolute workspace roots", async () => {
  for (const arguments_ of [
    { workspaceRoot: "relative", limit: 1 },
    { workspaceRoot: resolve("test/fixtures/node-project"), limit: 0 },
    { workspaceRoot: resolve("test/fixtures/node-project"), limit: 501 },
  ]) {
    const result = await client.callTool({ name: "discover_tests", arguments: arguments_ });
    assert.equal(result.isError, true);
  }
});

function fixtureRoot(): string {
  return resolve("test/fixtures/node-project");
}
