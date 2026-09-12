import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact exposes both binaries and launches the MCP server", async () => {
  const temp = mkdtempSync(join(tmpdir(), "workflow-guard-package-"));

  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const [{ filename }] = JSON.parse(packOutput) as [{ filename: string }];
    const tarball = join(temp, filename);
    const consumer = join(temp, "consumer");

    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: consumer, stdio: "ignore" });

    const installedPackage = JSON.parse(readFileSync(join(consumer, "node_modules", "workflow-guard-mcp", "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    assert.deepEqual(installedPackage.bin, {
      "workflow-guard-mcp": "./dist/server.js",
      "workflow-guard-claude-hook": "./dist/claude-hook.js",
    });
    const mcpBin = join(consumer, "node_modules", ".bin", "workflow-guard-mcp");
    const claudeBin = join(consumer, "node_modules", ".bin", "workflow-guard-claude-hook");
    accessSync(mcpBin, constants.X_OK);
    accessSync(claudeBin, constants.X_OK);

    const client = new Client({ name: "workflow-guard-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({
        command: mcpBin,
        cwd: consumer,
        stderr: "pipe",
      }));
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["guard_check", "guard_status"]);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
