import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client: Client;
let workspace: string;
let dataRoot: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "project-memory-mcp-workspace-"));
  dataRoot = await mkdtemp(join(tmpdir(), "project-memory-mcp-data-"));
  client = new Client({ name: "project-memory-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), stderr: "pipe",
    env: { PROJECT_MEMORY_DATA_DIR: dataRoot },
  }));
});

after(async () => {
  await client.close();
  await Promise.all([rm(workspace, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]);
});

test("compiled server exposes bounded record and search schemas", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "project-memory-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ["record_memory", "search_memory"]);
  assert.equal(tools[0]?.annotations?.readOnlyHint, false);
  assert.equal(tools[1]?.annotations?.readOnlyHint, true);
  assert.ok(tools.every((tool) => tool.outputSchema));
  assert.match(tools[0]?.description ?? "", /durable facts, decisions, constraints, or lessons/);
  assert.match(tools[0]?.description ?? "", /do not record transient tool output or speculation/);
  assert.match(tools[1]?.description ?? "", /Proactively search current project memory/);
  assert.match(tools[1]?.description ?? "", /assertions, not proof/);
  assert.equal((await client.callTool({ name: "record_memory", arguments: { workspaceRoot: workspace, kind: "rumor", content: "invalid" } })).isError, true);
  assert.equal((await client.callTool({ name: "search_memory", arguments: { workspaceRoot: workspace, query: "x", limit: 21 } })).isError, true);
});

test("recorded memory survives MCP calls and is returned as assertion provenance", async () => {
  const written = await client.callTool({ name: "record_memory", arguments: { workspaceRoot: workspace, kind: "decision", content: "Use alpha storage", paths: ["src/storage.ts"] } });
  assert.equal(written.isError, undefined);
  const record = (written.structuredContent as { record: { evidenceClass: string; freshness: string } }).record;
  assert.equal(record.evidenceClass, "assertion");
  assert.equal(record.freshness, "fresh");

  const found = await client.callTool({ name: "search_memory", arguments: { workspaceRoot: workspace, query: "alpha" } });
  assert.equal(found.isError, undefined);
  const result = found.structuredContent as { records: Array<{ content: string }>; truncated: boolean };
  assert.equal(result.records[0]?.content, "Use alpha storage");
  assert.equal(result.truncated, false);
});
