import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";

async function fakeUpstream(): Promise<{ url: string; hits: number; close: () => Promise<void> }> {
  const state = { hits: 0 };
  const server = http.createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    get hits() {
      return state.hits;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

test("proxy rejects a stripped K3 replay before it reaches upstream", async () => {
  const upstream = await fakeUpstream();
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "I'll read it." },
          { role: "tool", tool_call_id: "call_1", content: "body" },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(upstream.hits, 0, "rejected replay must not be forwarded");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy diverts a DeepSeek synthesized tool-call turn to the Anthropic path", async () => {
  const upstream = await fakeUpstream();
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "user", content: "go" },
          { role: "tool", tool_call_id: "call_seed", content: "seeded" },
        ],
      }),
    });
    assert.equal(response.status, 409);
    assert.equal(upstream.hits, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("proxy forwards a valid K3 preserved-thinking replay", async () => {
  const upstream = await fakeUpstream();
  const proxy = await createModelUsageProxy({ upstream: upstream.url, apiKey: "REAL_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: null, reasoning_content: "thinking", tool_calls: [{ id: "call_1", type: "function", function: { name: "read" } }] },
          { role: "tool", tool_call_id: "call_1", content: "body" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.hits, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
