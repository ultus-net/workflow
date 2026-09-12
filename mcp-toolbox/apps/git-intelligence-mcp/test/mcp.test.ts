import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectCompiledStdioClient } from "../../../packages/test-support/mcp-client.ts";
import { createRepository } from "./git-fixture.ts";

let client: Client;

before(async () => {
  client = await connectCompiledStdioClient("git-intelligence-black-box-test");
});

after(async () => client.close());

test("initializes the compiled stdio server and exposes working-tree status", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "git-intelligence-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["working_tree_status", "local_diff", "file_history", "file_blame"]);
  assert.ok(tools[0]?.outputSchema);
  assert.equal(tools[0]?.annotations?.readOnlyHint, true);
});

test("returns structured local diffs and validates scope", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "tracked.txt"), "changed\n");
  const result = await client.callTool({ name: "local_diff", arguments: { workspaceRoot: fixture.root, scope: "unstaged" } });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { files: Array<{ path: string }> }).files[0]?.path, "tracked.txt");
  assert.equal((await client.callTool({ name: "local_diff", arguments: { workspaceRoot: fixture.root, scope: "other" } })).isError, true);
});

test("returns structured status and validates public bounds", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.root, "untracked.txt"), "new\n");
  const result = await client.callTool({ name: "working_tree_status", arguments: { workspaceRoot: fixture.root } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    entries: [{ path: "untracked.txt", staged: "none", unstaged: "untracked" }],
    truncated: false,
  });
  for (const arguments_ of [
    { workspaceRoot: "relative" },
    { workspaceRoot: fixture.root, limit: 0 },
    { workspaceRoot: fixture.root, limit: 501 },
  ]) {
    assert.equal((await client.callTool({ name: "working_tree_status", arguments: arguments_ })).isError, true);
  }
});

test("returns file history and blame with public bounds", async (t) => {
  const fixture = createRepository();
  t.after(fixture.cleanup);
  const history = await client.callTool({ name: "file_history", arguments: { workspaceRoot: fixture.root, path: "tracked.txt" } });
  assert.equal(history.isError, undefined);
  assert.equal((history.structuredContent as { commits: Array<{ path: string }> }).commits[0]?.path, "tracked.txt");
  const blame = await client.callTool({ name: "file_blame", arguments: { workspaceRoot: fixture.root, path: "tracked.txt" } });
  assert.equal(blame.isError, undefined);
  assert.equal((blame.structuredContent as { lines: Array<{ finalLine: number }> }).lines[0]?.finalLine, 1);
  assert.equal((await client.callTool({ name: "file_history", arguments: { workspaceRoot: fixture.root, path: "tracked.txt", limit: 201 } })).isError, true);
  assert.equal((await client.callTool({ name: "file_blame", arguments: { workspaceRoot: fixture.root, path: "tracked.txt", limit: 1001 } })).isError, true);
});
