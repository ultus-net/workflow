import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectCompiledStdioClient } from "../../../packages/test-support/mcp-client.ts";

let client: Client;

before(async () => {
  client = await connectCompiledStdioClient("workflow-guard-black-box-test");
});

after(async () => {
  await client.close();
});

test("initializes the compiled stdio server and discovers its tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["guard_check", "guard_status"],
  );
  assert.ok(tools.find((tool) => tool.name === "guard_check")?.outputSchema);
  assert.match(tools.find((tool) => tool.name === "guard_status")?.description ?? "", /Proactively call at the start/);
});

test("emits leveled log notifications for guard verdicts", async () => {
  const { LoggingMessageNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const logs: { level: string; data: unknown }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logs.push(notification.params as never);
  });

  await client.callTool({ name: "guard_check", arguments: { action: "shell", command: "git status" } });
  await client.callTool({ name: "guard_check", arguments: { action: "shell", command: "rm -rf /" } });

  const allowLog = logs.find((log) => (log.data as { verdict?: string }).verdict === "allow");
  const denyLog = logs.find((log) => (log.data as { verdict?: string }).verdict === "deny");
  assert.equal(allowLog?.level, "debug");
  assert.equal(denyLog?.level, "error");
  assert.match(String((denyLog?.data as { reason?: string }).reason), /./);
});

test("returns structured allow and deny policy decisions", async () => {
  const allowed = await client.callTool({
    name: "guard_check",
    arguments: { action: "shell", command: "git status" },
  });
  assert.equal(allowed.isError, undefined);
  assert.deepEqual(allowed.structuredContent, {
    decision: "allow",
    policy: "baseline",
    reason: "No baseline high-risk policy matched the proposed action.",
  });

  const denied = await client.callTool({
    name: "guard_check",
    arguments: { action: "file_write", path: ".env" },
  });
  assert.equal(denied.isError, undefined);
  assert.deepEqual(denied.structuredContent, {
    decision: "deny",
    policy: "protected-path",
    reason: "secret credential path",
  });
});

test("reports advisory status through the public tool", async () => {
  const result = await client.callTool({ name: "guard_status", arguments: {} });
  const status = JSON.parse((result.content as any)[0].text);
  assert.equal(status.mode, "policy-advisor");
  assert.equal(status.enforcement, "host-dependent");
  assert.equal(status.executesActions, false);
  assert.ok(status.preconditions?.modifications);
  assert.ok(status.circuitBreaker?.guidance);
  assert.ok(status.recommendedActions?.some((action: string) => action.includes("fresh verification")));
});

test("rejects malformed guard_check input at the MCP boundary", async () => {
  const result = await client.callTool({
    name: "guard_check",
    arguments: { action: "not-a-guard-action" },
  });
  assert.equal(result.isError, true);
});
