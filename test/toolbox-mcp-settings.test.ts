import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectToolboxMcpServers } from "../src/cli/mcp-settings.js";

function fakeToolbox(): string {
  const root = mkdtempSync(join(tmpdir(), "toolbox-fixture-"));
  for (const name of ["workflow-guard-mcp", "test-intelligence-mcp"]) {
    const dir = join(root, "apps", name, "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server.js"), "// fake");
  }
  // an app without a built dist must be skipped
  mkdirSync(join(root, "apps", "learning-mcp"), { recursive: true });
  return root;
}

test("collectToolboxMcpServers emits stdio entries for built apps only", () => {
  const servers = collectToolboxMcpServers(fakeToolbox());
  assert.deepEqual(Object.keys(servers).sort(), ["test-intelligence", "workflow-guard"]);
  const entry = servers["workflow-guard"]!;
  assert.equal(entry.type, "stdio");
  assert.equal(entry.command, process.execPath);
  assert.match(entry.args[0]!, /apps\/workflow-guard-mcp\/dist\/server\.js$/);
});

test("collectToolboxMcpServers returns empty when nothing is built", () => {
  const root = mkdtempSync(join(tmpdir(), "toolbox-empty-"));
  mkdirSync(join(root, "apps", "learning-mcp"), { recursive: true });
  assert.deepEqual(collectToolboxMcpServers(root), {});
});
