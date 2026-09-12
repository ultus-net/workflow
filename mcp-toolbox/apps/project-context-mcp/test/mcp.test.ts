import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("compiled MCP exposes one bounded read-only discovery tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-context-mcp-")); await writeFile(join(root, "TODO.md"), "- [ ] P1 - Example task\n"); const client = new Client({ name: "project-context-test", version: "1" }); await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), stderr: "pipe" }));
  const { tools } = await client.listTools(); assert.deepEqual(tools.map(({ name }) => name), ["discover_project_context"]); assert.equal(tools[0]?.annotations?.readOnlyHint, true); assert.match(tools[0]?.description ?? "", /Proactively call at the start/); assert.match(tools[0]?.description ?? "", /untrusted/); const response = await client.callTool({ name: "discover_project_context", arguments: { workspaceRoot: root } }); assert.equal(response.isError, undefined); const result = response.structuredContent as { candidates: Array<{ path: string; snippet: string; trust: string }> }; assert.deepEqual(result.candidates, [{ path: "TODO.md", precedence: 1, snippet: "- [ ] P1 - Example task\n", snippetTruncated: false, trust: "untrusted_repository_content" }]);
  await client.close(); await unlink(join(root, "TODO.md")); await rmdir(root);
});
