import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakeProvider } from "./fake-provider.ts";

test("packed npm artifact installs independently and launches its MCP binary", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ci-intelligence-package-"));
  const provider = await createFakeProvider();
  try {
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "ci-intelligence-mcp", "package.json"), "utf8")) as { bin?: Record<string, string>; dependencies?: Record<string, string> };
    assert.deepEqual(installed.bin, { "ci-intelligence-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "ci-intelligence-mcp");
    accessSync(binary, constants.X_OK);
    const client = new Client({ name: "ci-intelligence-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe", env: { CI_GITHUB_REPOSITORY: "acme/widgets", CI_GITHUB_API_URL: provider.url } }));
      assert.deepEqual(client.getServerVersion(), { name: "ci-intelligence-mcp", version: "0.1.0" });
      assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ["list_ci_runs", "list_ci_jobs"]);
      const result = await client.callTool({ name: "list_ci_runs", arguments: {} });
      assert.equal((result.structuredContent as { runs: Array<{ id: string }> }).runs[0]?.id, "github:7");
    } finally { await client.close(); }
  } finally {
    await provider.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
