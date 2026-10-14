import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { isAllowed } from "../../../src/assistant/discord/allowlist.js";
import { chunkMessage, DISCORD_MESSAGE_LIMIT } from "../../../src/assistant/discord/messaging.js";
import { Debouncer } from "../../../src/assistant/discord/debouncer.js";
import { DraftStream } from "../../../src/assistant/discord/draft-stream.js";
import {
  createDiscordGatewayClient,
  handleIncoming,
  type DiscordBridgeOptions,
  type DiscordGatewayClient,
  type DiscordIncomingMessage,
} from "../../../src/assistant/discord/bridge.js";

/** A fake gateway that records every `complete` call and returns canned text. */
function fakeGateway(text = "reply"): DiscordGatewayClient & { readonly calls: Parameters<DiscordGatewayClient["complete"]>[0][] } {
  const calls: Parameters<DiscordGatewayClient["complete"]>[0][] = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      return text;
    },
  };
}

const openList = { allow: [], deny: [] };
const restricted = { allow: ["u-1", "u-2"], deny: ["u-2"] };

test("isAllowed: deny wins, empty allow is open, membership, empty id false", () => {
  assert.equal(isAllowed("u-2", restricted), false, "deny beats allow");
  assert.equal(isAllowed("u-1", restricted), true, "allow-list membership");
  assert.equal(isAllowed("u-9", restricted), false, "outside the allow list");
  assert.equal(isAllowed("u-9", openList), true, "empty allow is open");
  assert.equal(isAllowed("u-2", { allow: [], deny: ["u-2"] }), false, "deny wins over open");
  assert.equal(isAllowed("", openList), false, "empty id denied");
});

test("chunkMessage: splits under the limit and never exceeds it", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
  const text = lines.join("\n");
  const chunks = chunkMessage(text, 200);
  assert.ok(chunks.length > 1, "long text splits into multiple chunks");
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `chunk within limit: ${chunk.length}`);
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"), "content preserved up to blank-line collapsing");
});

test("chunkMessage: no chunk exceeds the default limit", () => {
  const text = "a".repeat(DISCORD_MESSAGE_LIMIT * 2 + 13);
  const chunks = chunkMessage(text);
  for (const chunk of chunks) assert.ok(chunk.length <= DISCORD_MESSAGE_LIMIT);
  assert.equal(chunks.join("").length, text.length);
});

test("chunkMessage: a single over-long line is hard-split", () => {
  const long = "y".repeat(50);
  const chunks = chunkMessage(long, 10);
  assert.deepEqual(chunks, ["y".repeat(10), "y".repeat(10), "y".repeat(10), "y".repeat(10), "y".repeat(10)]);
  for (const chunk of chunks) assert.ok(chunk.length <= 10);
});

test("chunkMessage: empty or whitespace-only is []", () => {
  assert.deepEqual(chunkMessage(""), []);
  assert.deepEqual(chunkMessage("   \n  \n"), []);
});

test("Debouncer: two rapid schedules for one key run once (the last)", () => {
  const now = (): number => 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const debouncer = new Debouncer({
    delayMs: 100,
    now,
    setTimer: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { fn: () => void; ms: number });
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const ran: string[] = [];
  debouncer.schedule("c1", async () => {
    ran.push("first");
  });
  debouncer.schedule("c1", async () => {
    ran.push("second");
  });
  assert.equal(timers.length, 1, "the first timer was cleared");
  timers[0]!.fn();
  assert.deepEqual(ran, ["second"], "only the last run fired");
});

test("Debouncer: cancel prevents the run", () => {
  const timers: (() => void)[] = [];
  const debouncer = new Debouncer({
    delayMs: 100,
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => {
      timers.length = 0;
    },
  });
  const ran: string[] = [];
  debouncer.schedule("c1", async () => {
    ran.push("run");
  });
  debouncer.cancel("c1");
  assert.equal(timers.length, 0, "cancelled timer removed");
  assert.deepEqual(ran, []);
});

test("DraftStream: first true, false immediately after markEdited, true after the interval", () => {
  let now = 0;
  const stream = new DraftStream({ minIntervalMs: 100, now: () => now });
  assert.equal(stream.lastEditAt, undefined);
  assert.equal(stream.shouldEdit(), true, "no edit yet");
  stream.markEdited();
  assert.equal(stream.lastEditAt, 0);
  assert.equal(stream.shouldEdit(), false, "immediately after an edit");
  now = 100;
  assert.equal(stream.shouldEdit(), true, "interval elapsed");
});

test("handleIncoming: disallowed author returns undefined and does NOT call the gateway", async () => {
  const gateway = fakeGateway();
  const options: DiscordBridgeOptions = { allowlist: restricted, gateway };
  const message: DiscordIncomingMessage = { channelId: "c", messageId: "m", authorId: "u-2", content: "hi" };
  const reply = await handleIncoming(options, message);
  assert.equal(reply, undefined);
  assert.equal(gateway.calls.length, 0, "gateway not called");
});

test("handleIncoming: allowed author calls complete with the identity and returns the text", async () => {
  const gateway = fakeGateway("hello back");
  const options: DiscordBridgeOptions = { allowlist: restricted, gateway };
  const message: DiscordIncomingMessage = { channelId: "c", messageId: "m", authorId: "u-1", content: "hi" };
  const reply = await handleIncoming(options, message);
  assert.deepEqual(reply, { identity: "u-1", text: "hello back" });
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0]!.identity, "u-1");
  assert.deepEqual(gateway.calls[0]!.messages, [{ role: "user", content: "hi" }]);
});

test("createDiscordGatewayClient: sends the identity + placeholder headers and parses the content", async () => {
  const seen: { headers?: http.IncomingHttpHeaders; body?: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from gateway" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    const client = createDiscordGatewayClient({ gatewayUrl: `http://127.0.0.1:${address.port}`, basicAuth: "b3BlbmNvZGU6cHc=" });
    const text = await client.complete({ identity: "snowflake-42", messages: [{ role: "user", content: "ping" }] });
    assert.equal(text, "from gateway");
    const request = seen[0]!;
    assert.equal(request.headers?.["x-workflow-user"], "snowflake-42", "identity header");
    assert.equal(request.headers?.authorization, "Basic b3BlbmNvZGU6cHc=", "front-door client credential");
    const body = JSON.parse(request.body ?? "{}") as { messages?: unknown[]; stream?: boolean };
    assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
    assert.equal(body.stream, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  }
});

test("createDiscordGatewayClient: a 500 throws", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "boom" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    const client = createDiscordGatewayClient({ gatewayUrl: `http://127.0.0.1:${address.port}`, basicAuth: "x" });
    await assert.rejects(
      () => client.complete({ identity: "u", messages: [{ role: "user", content: "hi" }] }),
      /discord gateway 500/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  }
});
