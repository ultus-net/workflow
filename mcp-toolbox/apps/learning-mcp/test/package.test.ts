import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact independently serves the pedagogy tools", async () => {
  const temp = mkdtempSync(join(tmpdir(), "learning-mcp-package-"));
  try {
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const consumer = join(temp, "consumer");
    const dataRoot = join(temp, "data");
    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "learning-mcp", "package.json"), "utf8")) as { bin?: Record<string, string>; dependencies?: Record<string, string> };
    assert.deepEqual(installed.bin, { "learning-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "learning-mcp");
    accessSync(binary, constants.X_OK);
    const client = new Client({ name: "learning-mcp-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe", env: { LEARNING_MCP_DATA_DIR: dataRoot } }));
      assert.deepEqual(client.getServerVersion(), { name: "learning-mcp", version: "0.1.0" });
      const result = await client.callTool({ name: "learning_checkpoint", arguments: {
        concept: "fs:atomic-swaps", category: "systems", relevance: 0.9, consequence: 0.9,
        teachableInsight: "renameSync is atomic on POSIX.", socraticQuestion: "Why write to a temp file first?",
        mode: "socratic-tutor", sessionInterventions: 0,
      } });
      assert.equal((result.structuredContent as { interrupt: boolean }).interrupt, true);
    } finally { await client.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
