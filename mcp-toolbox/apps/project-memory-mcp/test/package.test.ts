import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact independently records and searches memory", async () => {
  const temp = mkdtempSync(join(tmpdir(), "project-memory-package-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" });
    // W105: npm 12 changed `npm pack --json` from the legacy array to a
    // keyed object (keyed by package name). Extract THIS package's entry
    // either way so the test stays version-portable, and pin the entry's
    // name — the old array destructure never checked which entry it got.
    const parsed = JSON.parse(packOutput) as
      | Array<{ filename: string; name?: string }>
      | Record<string, { filename: string; name?: string }>;
    const entry = Array.isArray(parsed) ? parsed[0] : parsed["project-memory-mcp"];
    assert.ok(entry, "npm pack --json returned no entry for project-memory-mcp");
    assert.equal(entry.name, "project-memory-mcp");
    const filename = entry.filename;
    const consumer = join(temp, "consumer");
    const workspace = join(temp, "workspace");
    const dataRoot = join(temp, "data");
    mkdirSync(consumer);
    mkdirSync(workspace);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "project-memory-mcp", "package.json"), "utf8")) as { bin?: Record<string, string>; dependencies?: Record<string, string> };
    assert.deepEqual(installed.bin, { "project-memory-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "project-memory-mcp");
    accessSync(binary, constants.X_OK);
    const client = new Client({ name: "project-memory-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({
        command: binary, cwd: consumer, stderr: "pipe",
        env: {
          PROJECT_MEMORY_DATA_DIR: dataRoot,
          PROJECT_MEMORY_WRITER: "project-memory-package-test",
          PROJECT_MEMORY_WRITER_AUTHORITY: "agent",
          PROJECT_MEMORY_ORIGIN_SURFACE: "test:package",
        },
      }));
      assert.deepEqual(client.getServerVersion(), { name: "project-memory-mcp", version: "0.1.0" });
      await client.callTool({ name: "record_memory", arguments: { workspaceRoot: workspace, kind: "lesson", content: "packed durable knowledge" } });
      const result = await client.callTool({ name: "search_memory", arguments: { workspaceRoot: workspace, query: "durable" } });
      assert.equal((result.structuredContent as { records: Array<{ content: string }> }).records[0]?.content, "packed durable knowledge");
    } finally { await client.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
