import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRepository } from "./git-fixture.ts";

test("packed npm artifact installs independently and launches its MCP binary", async () => {
  const temp = mkdtempSync(join(tmpdir(), "git-intelligence-package-"));
  const repository = createRepository();
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

    const installedPackage = JSON.parse(readFileSync(join(consumer, "node_modules", "git-intelligence-mcp", "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    assert.deepEqual(installedPackage.bin, { "git-intelligence-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installedPackage.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "git-intelligence-mcp");
    accessSync(binary, constants.X_OK);

    const client = new Client({ name: "git-intelligence-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe" }));
      assert.deepEqual(client.getServerVersion(), { name: "git-intelligence-mcp", version: "0.1.0" });
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ["working_tree_status", "local_diff", "file_history", "file_blame"]);
      const result = await client.callTool({ name: "working_tree_status", arguments: { workspaceRoot: repository.root } });
      assert.deepEqual(result.structuredContent, { entries: [], truncated: false });
      const diff = await client.callTool({ name: "local_diff", arguments: { workspaceRoot: repository.root, scope: "unstaged" } });
      assert.deepEqual(diff.structuredContent, { files: [], truncated: false, evidenceTruncated: false });
      const history = await client.callTool({ name: "file_history", arguments: { workspaceRoot: repository.root, path: "tracked.txt" } });
      assert.equal((history.structuredContent as { commits: Array<{ path: string }> }).commits[0]?.path, "tracked.txt");
      const blame = await client.callTool({ name: "file_blame", arguments: { workspaceRoot: repository.root, path: "tracked.txt" } });
      assert.equal((blame.structuredContent as { lines: Array<{ finalLine: number }> }).lines[0]?.finalLine, 1);
    } finally {
      await client.close();
    }
  } finally {
    repository.cleanup();
    rmSync(temp, { recursive: true, force: true });
  }
});
