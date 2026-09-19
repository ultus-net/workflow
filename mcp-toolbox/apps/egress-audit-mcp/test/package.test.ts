import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact independently appends and summarizes egress reaches", async () => {
  const temp = mkdtempSync(join(tmpdir(), "egress-audit-package-"));
  try {
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const consumer = join(temp, "consumer");
    const dataDir = join(temp, "data");
    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "egress-audit-mcp", "package.json"), "utf8")) as { bin?: Record<string, string>; dependencies?: Record<string, string> };
    assert.deepEqual(installed.bin, { "egress-audit-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "egress-audit-mcp");
    accessSync(binary, constants.X_OK);
    const client = new Client({ name: "egress-audit-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({
        command: binary,
        cwd: consumer,
        stderr: "pipe",
        env: { ...process.env, EGRESS_AUDIT_DATA_DIR: dataDir },
      }));
      assert.deepEqual(client.getServerVersion(), { name: "egress-audit-mcp", version: "0.1.0" });
      const appended = await client.callTool({
        name: "append_egress_reach",
        arguments: { domain: "openrouter.ai", functionClass: "chat-completions", tokenClass: "session-placeholder" },
      });
      assert.equal(appended.isError, undefined);
      const summary = await client.callTool({ name: "summarize_egress", arguments: {} });
      assert.equal((summary.structuredContent as { entries: number }).entries, 1);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});