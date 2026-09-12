import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectToolboxMcpServers, mergeMcpSettings } from "../src/cli/mcp-settings.js";

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

test("mergeMcpSettings preserves user servers and lets toolbox win name conflicts", () => {
  const user = {
    mcpServers: {
      "web-search": { type: "streamableHttp", url: "https://example.test" },
      filesystem: { type: "stdio", command: "npx", args: ["fs-server"] },
    },
    otherTopLevel: true,
  };
  const merged = mergeMcpSettings(user, { filesystem: { type: "stdio", command: "node", args: ["/ours/server.js"] } });
  const servers = merged.mcpServers as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(servers).sort(), ["filesystem", "web-search"]);
  assert.equal(servers.filesystem!.command, "node");
  assert.equal(servers["web-search"]!.url, "https://example.test");
  assert.equal(merged.otherTopLevel, true);
});

test("collectToolboxMcpServers returns empty when nothing is built", () => {
  const root = mkdtempSync(join(tmpdir(), "toolbox-empty-"));
  mkdirSync(join(root, "apps", "learning-mcp"), { recursive: true });
  assert.deepEqual(collectToolboxMcpServers(root), {});
});
