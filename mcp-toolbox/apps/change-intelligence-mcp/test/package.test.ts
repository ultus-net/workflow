import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact installs independently and launches without primitive package dependencies", async () => {
  const temp = mkdtempSync(join(tmpdir(), "change-intelligence-package-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" });
    const [{ filename }] = JSON.parse(packOutput) as [{ filename: string }];
    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });

    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "change-intelligence-mcp", "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    assert.deepEqual(installed.bin, { "change-intelligence-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "change-intelligence-mcp");
    accessSync(binary, constants.X_OK);

    const client = new Client({ name: "change-intelligence-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe" }));
      assert.deepEqual(client.getServerVersion(), { name: "change-intelligence-mcp", version: "0.1.0" });
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ["assess_local_change"]);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
