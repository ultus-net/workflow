import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact installs independently and launches its MCP binary", async () => {
  const temp = mkdtempSync(join(tmpdir(), "test-intelligence-package-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const [{ filename }] = JSON.parse(packOutput) as [{ filename: string }];
    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    writeFileSync(join(consumer, "packed.test.ts"), `import test from "node:test";\ntest("packed artifact executes TypeScript", () => {});\n`);

    const installedPackage = JSON.parse(readFileSync(join(consumer, "node_modules", "test-intelligence-mcp", "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    assert.deepEqual(installedPackage.bin, { "test-intelligence-mcp": "./dist/server.js" });
    assert.ok(installedPackage.dependencies?.tsx, "tsx must ship as a runtime dependency for the Node adapter");
    const binary = join(consumer, "node_modules", ".bin", "test-intelligence-mcp");
    accessSync(binary, constants.X_OK);

    const client = new Client({ name: "test-intelligence-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe" }));
      assert.deepEqual(client.getServerVersion(), { name: "test-intelligence-mcp", version: "0.1.0" });
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ["discover_tests", "find_relevant_tests", "run_tests"]);
      const relevance = await client.callTool({
        name: "find_relevant_tests",
        arguments: { workspaceRoot: consumer, file: "packed.test.ts", limit: 1 },
      });
      assert.equal(relevance.isError, undefined);
      assert.deepEqual(relevance.structuredContent, {
        tests: [{ id: "node:packed.test.ts", file: "packed.test.ts", label: "packed.test.ts", runner: "node", relevance: "exact_file" }],
        truncated: false,
      });
      const result = await client.callTool({
        name: "run_tests",
        arguments: { workspaceRoot: consumer, testIds: ["node:packed.test.ts"], timeoutMs: 30_000 },
      });
      assert.equal(result.isError, undefined);
      const executions = (result.structuredContent as { tests: Array<{ name: string; file: string; status: string }> }).tests;
      assert.deepEqual(executions.map(({ name, file, status }) => ({ name, file, status })), [
        { name: "packed artifact executes TypeScript", file: "packed.test.ts", status: "passed" },
      ]);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
