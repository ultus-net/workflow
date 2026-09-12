import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectCompiledStdioClient } from "../../../packages/test-support/mcp-client.ts";

let client: Client;

before(async () => {
  client = await connectCompiledStdioClient("continuity-checkpoint-black-box-test");
});

after(async () => {
  await client.close();
});

test("emits MCP log and progress notifications for tool calls", async () => {
  const { LoggingMessageNotificationSchema, ProgressNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const logs: { level: string; data: { tool?: string; phase?: string } }[] = [];
  const progress: { message?: string }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { logs.push(notification.params as never); });
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => { progress.push(notification.params as never); });

  await client.callTool({
    name: "recover_continuity",
    arguments: { workspaceRoot: process.cwd(), memoryQuery: "x", maxChars: 2_000, sourceLimit: 2 },
    _meta: { progressToken: "rollout-probe" },
  });

  assert.ok(logs.some((log) => log.level === "debug" && log.data.phase === "start"), "expected debug start log, got " + JSON.stringify(logs));
  assert.ok(
    logs.some((log) => (log.level === "info" && log.data.phase === "done") || (log.level === "error" && log.data.phase === "error")),
    "expected done or error log, got " + JSON.stringify(logs),
  );
  assert.equal(progress[0]?.message, "start");
});
