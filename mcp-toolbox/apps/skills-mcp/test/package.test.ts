import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact installs independently and launches its MCP binary", async () => {
  const temp = mkdtempSync(join(tmpdir(), "skills-package-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    // W105: npm 12 changed `npm pack --json` from the legacy array to a
    // keyed object (keyed by package name). Extract THIS package's entry
    // either way so the test stays version-portable, and pin the entry's
    // name — the old array destructure never checked which entry it got.
    const parsed = JSON.parse(packOutput) as
      | Array<{ filename: string; name?: string }>
      | Record<string, { filename: string; name?: string }>;
    const entry = Array.isArray(parsed) ? parsed[0] : parsed["skills-mcp"];
    assert.ok(entry, "npm pack --json returned no entry for skills-mcp");
    assert.equal(entry.name, "skills-mcp");
    const filename = entry.filename;
    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });

    const installedPackage = JSON.parse(
      execFileSync("npm", ["ls", "skills-mcp", "--json"], { cwd: consumer, encoding: "utf8" }),
    ) as unknown;
    void installedPackage;
    const binary = join(consumer, "node_modules", ".bin", "skills-mcp");
    accessSync(binary, constants.X_OK);

    // The packed server needs a skills directory; ship it the fixture via env.
    const client = new Client({ name: "skills-package-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({
        command: binary,
        args: [],
        cwd: consumer,
        env: { ...process.env, SKILLS_MCP_DIR: join(process.cwd(), "test", "fixtures", "skills") },
        stderr: "pipe",
      }));
      assert.deepEqual(client.getServerVersion(), { name: "skills-mcp", version: "0.1.0" });
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ["list_skills", "read_skill"]);
      const delivered = await client.callTool({ name: "read_skill", arguments: { name: "code-review" } });
      assert.equal(delivered.isError, undefined);
      assert.match((delivered.structuredContent as { content: string }).content, /# Code Review/);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
