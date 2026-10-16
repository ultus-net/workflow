import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { connectCompiledStdioClient } from "../../../packages/test-support/mcp-client.ts";

let client: Client;

before(async () => {
  client = await connectCompiledStdioClient("notify-mcp-black-box-test");
});

after(async () => {
  await client.close();
});

test("notify delivers through the recording channel and returns a receipt", async () => {
  const result = await client.callTool({
    name: "notify",
    arguments: { reminderId: "reminder-meds-0800", recipient: "care-recipient", body: "Take your 08:00 medication." },
  });
  const structured = result.structuredContent as { deliveryId: string; delivered: boolean; channel: string };
  assert.equal(structured.channel, "recording", "v1 defaults to the recording channel");
  assert.equal(structured.delivered, true);
  assert.equal(typeof structured.deliveryId, "string");
  assert.ok(structured.deliveryId.length > 0, "the receipt carries a delivery id");
});

test("notify rejects an unknown channel (fail closed, never a silent no-op)", async () => {
  const result = await client.callTool({
    name: "notify",
    arguments: { reminderId: "r-1", recipient: "x", body: "y", channel: "discord" },
  });
  assert.equal(result.isError, true, "an unimplemented channel is a tool error, not an undelivered reminder");
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  assert.match(text, /unknown notification channel/);
});

test("notify streams MCP log notifications for tool calls", async () => {
  const { LoggingMessageNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const logs: { level: string; data: { tool?: string; phase?: string } }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { logs.push(notification.params as never); });
  await client.callTool({ name: "notify", arguments: { reminderId: "r-2", recipient: "x", body: "y" } });
  assert.ok(logs.some((log) => log.level === "debug" && log.data.phase === "start"), "expected debug start log, got " + JSON.stringify(logs));
  assert.ok(logs.some((log) => log.level === "info" && log.data.phase === "done"), "expected info done log, got " + JSON.stringify(logs));
});
