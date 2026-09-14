import assert from "node:assert/strict";
import { test } from "node:test";

import { createOpenCodeSessionClient } from "../src/integrations/opencode-client.js";

test("OpenCode client creates sessions and posts prompts to the selected session", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    return new Response(JSON.stringify(calls.length === 1 ? { id: "s1" } : { parts: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createOpenCodeSessionClient("http://x:1/");
    assert.equal((await client.create({})).data?.id, "s1");
    await client.prompt({ path: { id: "s1" }, body: { parts: [{ type: "text", text: "hi" }] } });
    assert.equal(calls[0]?.url, "http://x:1/session");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[1]?.url, "http://x:1/session/s1/message");
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenCode client maps non-ok abort responses to errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    const result = await createOpenCodeSessionClient("http://x:1").abort({ path: { id: "s1" } });
    assert.match(String(result.error), /status 500/);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenCode client parses CRLF and chunked SSE frames", async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"type\":\"session.status\",\"properties\":{}}\r\n\r"));
      controller.enqueue(encoder.encode("\ndata: {\"type\":\"session.error\",\"properties\":{\"error\":\"x\"}}\r\n\r\n"));
      controller.close();
    },
  }), { status: 200 })) as typeof fetch;
  try {
    const { stream } = await createOpenCodeSessionClient("http://x:1").event.subscribe();
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    assert.deepEqual(events, [
      { type: "session.status", properties: {} },
      { type: "session.error", properties: { error: "x" } },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
