import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The compiled server reads EGRESS_AUDIT_DATA_DIR from the environment. The
// SDK's stdio transport forwards only a limited default env, so the directory
// must be passed explicitly.
let client: Client;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "egress-audit-mcp-"));
  client = new Client({ name: "egress-audit-mcp-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: { ...process.env, EGRESS_AUDIT_DATA_DIR: dataDir },
  }));
});

after(async () => {
  await client.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("exposes the three ledger tools with honest schemas and read-only flags", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "egress-audit-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["append_egress_reach", "query_egress_reaches", "summarize_egress"]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
  assert.deepEqual(annotations.append_egress_reach, { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(annotations.query_egress_reaches, { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(annotations.summarize_egress, { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false });
});

test("appends reaches, flags anomalies, and queries flagged reaches over MCP", async () => {
  const first = await client.callTool({
    name: "append_egress_reach",
    arguments: { domain: "api.example.com", functionClass: "chat-completions", tokenClass: "session-placeholder", source: "test" },
  });
  assert.equal(first.isError, undefined);
  const firstReach = (first.structuredContent as { reach: { anomalies: string[] } }).reach;
  assert.deepEqual(firstReach.anomalies, ["new-domain"]);

  const newcomer = await client.callTool({
    name: "append_egress_reach",
    arguments: { domain: "api.example.com", functionClass: "file-upload", tokenClass: "foreign", source: "test" },
  });
  const newcomerReach = (newcomer.structuredContent as { reach: { anomalies: string[] } }).reach;
  assert.deepEqual(newcomerReach.anomalies.sort(), ["new-function-class-on-known-domain", "non-session-token-observed"]);

  const flagged = await client.callTool({ name: "query_egress_reaches", arguments: { flaggedOnly: true, limit: 10 } });
  const flaggedBody = flagged.structuredContent as { reaches: Array<{ functionClass: string }>; truncated: boolean };
  assert.equal(flaggedBody.reaches.length, 2);
  assert.equal(flaggedBody.truncated, false);

  const summary = await client.callTool({ name: "summarize_egress", arguments: {} });
  const summaryBody = summary.structuredContent as { entries: number; anomalies: Array<{ flag: string; count: number }> };
  assert.equal(summaryBody.entries, 2);
  assert.equal(summaryBody.anomalies.find((entry) => entry.flag === "non-session-token-observed")?.count, 1);
});

test("rejects a non-hostname destination without writing a record", async () => {
  const bad = await client.callTool({
    name: "append_egress_reach",
    arguments: { domain: "https://api.example.com/upload", functionClass: "file-upload", tokenClass: "foreign" },
  });
  assert.equal(bad.isError, true);
  const summary = await client.callTool({ name: "summarize_egress", arguments: {} });
  assert.equal((summary.structuredContent as { entries: number }).entries, 2, "the rejected append must not change the ledger");
});