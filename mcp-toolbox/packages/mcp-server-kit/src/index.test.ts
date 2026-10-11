/**
 * Kit tests: the two behaviors the extraction must preserve byte-for-byte.
 *
 *  - `createLoggingServer` advertises the MCP logging capability.
 *  - `installToolStreaming` emits a `start`/`done` progress pair ONLY when the
 *    caller supplies a `_meta.progressToken`, levels `debug`/`info`/`error`
 *    logs only when a `logger` is configured, and returns the handler result
 *    unchanged (or `transform`-ed).
 *
 * Wrapper mechanics are pinned against a small fake `McpServer` (deterministic,
 * no wire); the final test drives a real `Client` over the SDK's in-memory
 * transport to prove the notifications ride the actual wire.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createLoggingServer, installToolStreaming, type ToolExtra } from "./index.js";

type SentNotification = { method: string; params: unknown };
type LogArg = { level: string; logger: string; data: { tool: string; phase: string; message?: string } };
type LooseHandler = (input: unknown, extra: ToolExtra) => Promise<unknown>;

interface Harness {
  server: McpServer;
  notifications: SentNotification[];
  logs: LogArg[];
  register: (name: string, handler: LooseHandler) => void;
  call: (tool: string, input: unknown, extra?: ToolExtra) => Promise<unknown>;
}

/** Minimal McpServer stand-in: captures the wrapped registerTool callbacks. */
function fakeServer(): Harness {
  const callbacks = new Map<string, LooseHandler>();
  const notifications: SentNotification[] = [];
  const logs: LogArg[] = [];
  const server = {
    registerTool: (name: string, _config: unknown, handler: LooseHandler) => {
      callbacks.set(name, handler);
      return {} as never;
    },
    server: {
      sendLoggingMessage: async (arg: LogArg) => {
        logs.push(arg);
      },
    },
  } as unknown as McpServer;
  return {
    server,
    notifications,
    logs,
    register: (name: string, handler: LooseHandler) => {
      (server.registerTool as unknown as (n: string, c: unknown, h: LooseHandler) => void)(name, { inputSchema: {} }, handler);
    },
    call: (tool: string, input: unknown, extra?: ToolExtra) => {
      const handler = callbacks.get(tool);
      assert.ok(handler, `tool ${tool} registered`);
      const base: ToolExtra = extra ?? {
        sendNotification: async (notification: unknown) => {
          notifications.push(notification as SentNotification);
        },
      };
      return handler(input, base);
    },
  };
}

test("createLoggingServer advertises the logging capability", async () => {
  const server = createLoggingServer({ name: "kit-logging-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kit-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  assert.ok(client.getServerCapabilities()?.logging !== undefined, "logging capability advertised");
  await client.close();
});

test("installToolStreaming streams start/done only when a progressToken is present", async () => {
  const harness = fakeServer();
  installToolStreaming(harness.server);
  harness.register("echo", async (input) => ({ echoed: input }));

  // No progressToken: no sendNotification at all.
  const noToken = await harness.call("echo", { v: "a" });
  assert.deepEqual(noToken, { echoed: { v: "a" } });
  assert.deepEqual(harness.notifications, [], "no progressToken, no progress notifications");

  // A progressToken: exactly the start(0)/done(2) pair, total 2.
  const tokenExtra: ToolExtra = {
    _meta: { progressToken: "tok-1" },
    sendNotification: async (notification: unknown) => {
      harness.notifications.push(notification as SentNotification);
    },
  };
  const withToken = await harness.call("echo", { v: "b" }, tokenExtra);
  assert.deepEqual(withToken, { echoed: { v: "b" } });
  assert.deepEqual(harness.notifications, [
    { method: "notifications/progress", params: { progressToken: "tok-1", progress: 0, total: 2, message: "start" } },
    { method: "notifications/progress", params: { progressToken: "tok-1", progress: 2, total: 2, message: "done" } },
  ]);
});

test("installToolStreaming returns the handler result unchanged without a transform", async () => {
  const harness = fakeServer();
  installToolStreaming(harness.server);
  const long = "x".repeat(100_000);
  harness.register("passthrough", async () => ({ content: [{ type: "text", text: long }], structuredContent: { big: true } }));
  const result = (await harness.call("passthrough", {})) as { content: Array<{ text: string }>; structuredContent: unknown };
  assert.equal(result.content[0]?.text.length, 100_000, "the kit does no bounding on its own");
  assert.deepEqual(result.structuredContent, { big: true });
});

test("installToolStreaming applies the configured result transform", async () => {
  const harness = fakeServer();
  installToolStreaming(harness.server, { transform: (result) => ({ ...(result as object), transformed: true }) });
  harness.register("transform", async () => ({ content: [{ type: "text", text: "ok" }] }));
  const result = (await harness.call("transform", {})) as { transformed?: boolean };
  assert.equal(result.transformed, true);
});

test("installToolStreaming levels debug/info logs only when a logger is configured", async () => {
  const silent = fakeServer();
  installToolStreaming(silent.server);
  silent.register("silent", async () => ({ ok: true }));
  await silent.call("silent", {});
  assert.equal(silent.logs.length, 0, "no logger, no log notifications");

  const loud = fakeServer();
  installToolStreaming(loud.server, { logger: "kit-loud" });
  loud.register("loud", async () => ({ ok: true }));
  await loud.call("loud", {});
  assert.deepEqual(loud.logs.map((log) => ({ level: log.level, logger: log.logger, phase: log.data.phase })), [
    { level: "debug", logger: "kit-loud", phase: "start" },
    { level: "info", logger: "kit-loud", phase: "done" },
  ]);
});

test("installToolStreaming logs an error and re-throws a failed handler", async () => {
  const harness = fakeServer();
  installToolStreaming(harness.server, { logger: "kit-error" });
  harness.register("boom", async () => {
    throw new Error("kaboom");
  });
  await assert.rejects(() => harness.call("boom", {}), /kaboom/);
  assert.deepEqual(
    harness.logs.map((log) => ({ level: log.level, phase: log.data.phase, message: log.data.message })),
    [
      { level: "debug", phase: "start", message: undefined },
      { level: "error", phase: "error", message: "kaboom" },
    ],
  );
});

test("the wrapper rides the real SDK wire (in-memory transport)", async () => {
  const server = createLoggingServer({ name: "kit-wire-test", version: "0.1.0" });
  installToolStreaming(server, { logger: "kit-wire" });
  server.registerTool("echo", { description: "echo", inputSchema: { value: z.string() } }, async (input) => ({
    content: [{ type: "text" as const, text: (input as { value: string }).value }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kit-wire-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const progress: Array<{ progress: number; total?: number | undefined; message?: string | undefined }> = [];
  const result = await client.callTool({ name: "echo", arguments: { value: "hi" } }, undefined, {
    onprogress: (update) => progress.push(update),
  });
  assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
  assert.deepEqual(
    progress.map((p) => ({ progress: p.progress, total: p.total, message: p.message })),
    [
      { progress: 0, total: 2, message: "start" },
      { progress: 2, total: 2, message: "done" },
    ],
  );
  await client.close();
});
