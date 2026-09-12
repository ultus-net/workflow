import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakeProvider } from "./fake-provider.ts";

let client: Client;
let closeProvider: () => Promise<void>;

before(async () => {
  const provider = await createFakeProvider();
  closeProvider = provider.close;
  client = new Client({ name: "ci-intelligence-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), stderr: "pipe",
    env: { CI_GITHUB_REPOSITORY: "acme/widgets", CI_GITHUB_API_URL: provider.url },
  }));
});

after(async () => { await client.close(); await closeProvider(); });

test("initializes the compiled server and exposes bounded read-only CI runs", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "ci-intelligence-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ["list_ci_runs", "list_ci_jobs"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.outputSchema);
  }
  const result = await client.callTool({ name: "list_ci_runs", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { runs: Array<{ id: string }> }).runs[0]?.id, "github:7");
  for (const arguments_ of [{ limit: 0 }, { limit: 101 }, { revision: "abc" }]) {
    assert.equal((await client.callTool({ name: "list_ci_runs", arguments: arguments_ })).isError, true);
  }
});

test("returns bounded job evidence through the compiled server", async () => {
  const result = await client.callTool({ name: "list_ci_jobs", arguments: { runId: "github:7", limit: 1 } });
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { jobs: Array<{ id: string; conclusion: string }>; truncated: boolean };
  assert.equal(structured.jobs[0]?.id, "github:72");
  assert.equal(structured.jobs[0]?.conclusion, "failure");
  assert.equal(structured.truncated, true);
  assert.equal((await client.callTool({ name: "list_ci_jobs", arguments: { runId: "7" } })).isError, true);
});

test("emits MCP log and progress notifications for tool calls", async () => {
  const { LoggingMessageNotificationSchema, ProgressNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const logs: { level: string; data: { tool?: string; phase?: string } }[] = [];
  const progress: { message?: string }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { logs.push(notification.params as never); });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => { progress.push(notification.params as never); });

  await client.callTool({ name: "list_ci_runs", arguments: {}, _meta: { progressToken: "rollout-probe" } });

  assert.ok(logs.some((log) => log.level === "debug" && log.data.phase === "start"), "expected debug start log, got " + JSON.stringify(logs));
  assert.ok(
    logs.some((log) => (log.level === "info" && log.data.phase === "done") || (log.level === "error" && log.data.phase === "error")),
    "expected done or error log, got " + JSON.stringify(logs),
  );
  assert.equal(progress[0]?.message, "start");
});
