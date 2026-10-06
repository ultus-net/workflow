import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  FALLBACK_AUTO_ROUTER_MODEL,
  fallbackBody,
  isFailoverStatus,
  isSyntheticUpstream,
  resolveMeteredLane,
  SYNTHETIC_AGENT_ROUTES,
  SYNTHETIC_ALIASES,
  SYNTHETIC_DEFAULT_MODEL,
  SYNTHETIC_MODELS_URL,
  syntheticAuthKeyFromAuth,
  syntheticUpstreamPath,
} from "../src/integrations/synthetic-provider.js";
import { createModelUsageProxy, METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";

const SYN = "https://api.synthetic.new";
const OR = "https://openrouter.ai";

interface FakeUpstream {
  readonly url: string;
  readonly seen: { authorization?: string; body?: string; url?: string }[];
  close(): Promise<void>;
}

async function fakeUpstream(handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void): Promise<FakeUpstream> {
  const seen: FakeUpstream["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry: { authorization?: string; body?: string; url?: string } = {};
      if (typeof req.headers.authorization === "string") entry.authorization = req.headers.authorization;
      entry.body = Buffer.concat(chunks).toString("utf8");
      if (typeof req.url === "string") entry.url = req.url;
      seen.push(entry);
      handler(req, Buffer.concat(chunks), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

// ── Pure policy ───────────────────────────────────────────────────────────

test("isSyntheticUpstream matches only the Synthetic host", () => {
  assert.equal(isSyntheticUpstream(SYN), true);
  assert.equal(isSyntheticUpstream("https://api.synthetic.new/v1"), true);
  assert.equal(isSyntheticUpstream(OR), false);
  assert.equal(isSyntheticUpstream("not a url"), false);
});

test("isFailoverStatus triggers on 429 and 5xx, never on 2xx/4xx-other", () => {
  assert.equal(isFailoverStatus(429), true);
  assert.equal(isFailoverStatus(500), true);
  assert.equal(isFailoverStatus(503), true);
  for (const status of [200, 204, 400, 401, 404, 409, 422]) {
    assert.equal(isFailoverStatus(status), false, `${status} must not trigger failover`);
  }
});

test("the alignment constants match the proven opencode-auto-router reference", () => {
  // Pinned so a future edit cannot silently drift from the working plugin.
  assert.equal(SYNTHETIC_DEFAULT_MODEL, "syn:large:text", "primaryModel default");
  assert.equal(SYNTHETIC_MODELS_URL, "https://api.synthetic.new/openai/v1/models", "catalog URL");
  assert.equal(FALLBACK_AUTO_ROUTER_MODEL, "openrouter/auto", "OpenRouter wire id (verbatim)");
  assert.deepEqual(Object.keys(SYNTHETIC_ALIASES).sort(), [
    "syn:large:text",
    "syn:large:vision",
    "syn:small:text",
    "syn:small:vision",
  ]);
  // The route table is ordered and every target is a registered syn:* alias.
  for (const route of SYNTHETIC_AGENT_ROUTES) {
    assert.ok(Object.hasOwn(SYNTHETIC_ALIASES, route.model), `route target ${route.model} is a syn:* alias`);
  }
});

test("fallbackBody re-pins the model to OpenRouter's verbatim Auto Router id and preserves the rest", () => {
  const body = { model: "syn:large:text", messages: [{ role: "user", content: "hi" }], stream: true };
  const next = fallbackBody(body);
  assert.equal(next.model, "openrouter/auto", "OpenRouter's wire id is openrouter/auto verbatim");
  assert.deepEqual(next.messages, body.messages);
  assert.equal(next.stream, true);
  assert.equal(body.model, "syn:large:text", "the input body is not mutated");
  assert.equal(FALLBACK_AUTO_ROUTER_MODEL, "openrouter/auto");
});

test("syntheticUpstreamPath maps the agent's /api/v1 base to Synthetic's /v1 (live-verified)", () => {
  assert.equal(syntheticUpstreamPath("/api/v1/chat/completions"), "/v1/chat/completions");
  assert.equal(syntheticUpstreamPath("/api/v1/models"), "/v1/models");
  // A path already in Synthetic's shape (or any other) passes through.
  assert.equal(syntheticUpstreamPath("/v1/chat/completions"), "/v1/chat/completions");
  assert.equal(syntheticUpstreamPath("/v1/messages"), "/v1/messages");
  assert.equal(syntheticUpstreamPath("/"), "/");
});

test("resolveMeteredLane composes the pair only with a Synthetic key and host", () => {
  const base = { env: { SYNTHETIC_API_KEY: "SYN" } as NodeJS.ProcessEnv, openrouterApiKey: "OR" };
  const composed = resolveMeteredLane({ ...base, configuredUpstream: SYN });
  assert.equal(composed.failover?.primary, SYN);
  assert.equal(composed.failover?.fallback, OR);
  assert.equal(composed.failover?.syntheticApiKey, "SYN");
  assert.equal(composed.failover?.openrouterApiKey, "OR");

  assert.equal(
    resolveMeteredLane({ ...base, configuredUpstream: OR }).failover,
    undefined,
    "a non-Synthetic configured upstream gets no failover pair",
  );
  assert.equal(
    resolveMeteredLane({ ...base, configuredUpstream: SYN, env: { WORKFLOW_SYNTHETIC: "0", SYNTHETIC_API_KEY: "SYN" } as NodeJS.ProcessEnv }).failover,
    undefined,
    "explicit off toggle disables the pair",
  );
  assert.equal(
    resolveMeteredLane({ ...base, env: {} as NodeJS.ProcessEnv, readKeyFile: () => undefined }).failover,
    undefined,
    "no resolvable key leaves the proxy single-upstream",
  );
});

test("resolveMeteredLane: Synthetic key makes Synthetic primary with an OpenRouter failover", () => {
  const lane = resolveMeteredLane({ env: { SYNTHETIC_API_KEY: "SYN" } as NodeJS.ProcessEnv, openrouterApiKey: "OR" });
  assert.equal(lane.upstream, SYN);
  assert.equal(lane.apiKey, "SYN");
  assert.equal(lane.failover?.fallback, OR);
  assert.equal(lane.failover?.openrouterApiKey, "OR");
});

test("syntheticAuthKeyFromAuth reads the auth store's synthetic.key", () => {
  assert.equal(syntheticAuthKeyFromAuth({ synthetic: { key: " sk-syn " } }), "sk-syn");
  assert.equal(syntheticAuthKeyFromAuth({ synthetic: { key: "   " } }), undefined);
  assert.equal(syntheticAuthKeyFromAuth({ openrouter: { key: "or" } }), undefined);
  assert.equal(syntheticAuthKeyFromAuth(null), undefined);
  // The auth-store key alone composes the lane (no env, no file).
  const lane = resolveMeteredLane({
    env: {} as NodeJS.ProcessEnv,
    openrouterApiKey: "OR",
    authKey: syntheticAuthKeyFromAuth({ synthetic: { key: "sk-syn" } }),
  });
  assert.equal(lane.upstream, SYN);
  assert.equal(lane.apiKey, "sk-syn");
});

test("resolveMeteredLane: no Synthetic key keeps today's OpenRouter single-upstream behavior", () => {
  const lane = resolveMeteredLane({ env: {} as NodeJS.ProcessEnv, openrouterApiKey: "OR" });
  assert.equal(lane.upstream, OR);
  assert.equal(lane.apiKey, "OR");
  assert.equal(lane.failover, undefined);
});

test("resolveMeteredLane: an explicit non-Synthetic upstream is never overridden", () => {
  const lane = resolveMeteredLane({
    env: { SYNTHETIC_API_KEY: "SYN" } as NodeJS.ProcessEnv,
    configuredUpstream: OR,
    openrouterApiKey: "OR",
  });
  assert.equal(lane.upstream, OR);
  assert.equal(lane.failover, undefined, "the failover only composes for a Synthetic primary");
});

test("resolveMeteredLane: explicit Synthetic upstream composes the pair; env toggle off disables it", () => {
  const on = resolveMeteredLane({
    env: { SYNTHETIC_API_KEY: "SYN" } as NodeJS.ProcessEnv,
    configuredUpstream: SYN,
    openrouterApiKey: "OR",
  });
  assert.equal(on.upstream, SYN);
  assert.equal(on.failover?.fallback, OR);

  const off = resolveMeteredLane({
    env: { WORKFLOW_SYNTHETIC: "false", SYNTHETIC_API_KEY: "SYN" } as NodeJS.ProcessEnv,
    configuredUpstream: SYN,
    openrouterApiKey: "OR",
  });
  assert.equal(off.upstream, SYN, "an explicit upstream is still honored");
  assert.equal(off.failover, undefined, "but the pair is disabled");
});

test("resolveMeteredLane: key-file fallback resolves when the env is empty", () => {
  const lane = resolveMeteredLane({
    env: {} as NodeJS.ProcessEnv,
    openrouterApiKey: "OR",
    readKeyFile: (name) => (name === "synthetic-api-key" ? "FILE_KEY" : undefined),
  });
  assert.equal(lane.upstream, SYN);
  assert.equal(lane.apiKey, "FILE_KEY");
});

test("resolveMeteredLane: Synthetic with no OpenRouter key runs Synthetic-only (no failover)", () => {
  const lane = resolveMeteredLane({ env: { SYNTHETIC_API_KEY: "SYN" } as NodeJS.ProcessEnv, openrouterApiKey: "" });
  assert.equal(lane.upstream, SYN);
  assert.equal(lane.apiKey, "SYN");
  assert.equal(lane.failover, undefined, "no fallback key means no fallback lane");
});

// ── Proxy integration ─────────────────────────────────────────────────────

const REQ = { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` };

async function proxyWithFailover(primaryUrl: string, fallbackUrl: string, onFailover?: (status: number | undefined) => void) {
  return createModelUsageProxy({
    upstream: primaryUrl,
    apiKey: "SYN_KEY",
    syntheticFailover: {
      fallback: fallbackUrl,
      fallbackApiKey: "OR_KEY",
      onFailover: (event) => onFailover?.(event.status),
    },
  });
}

test("a primary 429 fails over to OpenRouter with the model re-pinned and the fallback key", async () => {
  const primary = await fakeUpstream((_req, _body, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate limited" }));
  });
  const fallback = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0.0001 } }));
  });
  const events: (number | undefined)[] = [];
  const proxy = await proxyWithFailover(primary.url, fallback.url, (status) => events.push(status));
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: REQ,
      body: JSON.stringify({ model: "syn:large:text", messages: [] }),
    });
    assert.equal(response.status, 200, "the fallback's answer is surfaced");
    assert.equal(primary.seen.length, 1, "the primary is tried once");
    assert.equal(fallback.seen.length, 1, "the fallback is tried once");
    assert.equal(fallback.seen[0]?.authorization, "Bearer OR_KEY", "the fallback key is injected");
    assert.equal(primary.seen[0]?.url, "/v1/chat/completions", "the primary hop uses Synthetic's /v1 path");
    assert.equal(fallback.seen[0]?.url, "/api/v1/chat/completions", "the fallback hop keeps OpenRouter's /api/v1 path");
    const forwarded = JSON.parse(fallback.seen[0]?.body ?? "{}") as { model?: string; messages?: unknown };
    assert.equal(forwarded.model, "openrouter/auto", "the Synthetic id is re-pinned to OpenRouter's Auto Router id");
    assert.deepEqual(forwarded.messages, [], "the conversation is preserved");
    assert.deepEqual(proxy.failovers().map((event) => event.status), [429]);
    assert.deepEqual(events, [429], "the failover sink observed the trigger");
    assert.equal(proxy.failovers()[0]?.fromModel, "syn:large:text", "the journal labels the model that failed");
    assert.equal(proxy.failovers()[0]?.toModel, "openrouter/auto");
  } finally {
    await proxy.close();
    await primary.close();
    await fallback.close();
  }
});

test("a primary 503 fails over; a 200 does not", async () => {
  let status = 503;
  const primary = await fakeUpstream((_req, _body, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status < 400 }));
  });
  const fallback = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ from: "fallback" }));
  });
  const proxy = await proxyWithFailover(primary.url, fallback.url);
  try {
    const first = await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "syn:small:text" }) });
    assert.equal(first.status, 200);
    assert.equal(fallback.seen.length, 1);

    status = 200;
    const second = await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "syn:small:text" }) });
    assert.equal(second.status, 200);
    assert.equal(fallback.seen.length, 1, "a healthy primary is never failed over");
    assert.equal(primary.seen.length, 2);
  } finally {
    await proxy.close();
    await primary.close();
    await fallback.close();
  }
});

test("a primary connection failure fails over; a 400 is surfaced without failover", async () => {
  // A closed loopback port: fetch rejects with ECONNREFUSED.
  const dead = await fakeUpstream((_req, _body, res) => res.end());
  const deadUrl = dead.url;
  await dead.close();

  const fallback = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ from: "fallback" }));
  });
  const proxy = await proxyWithFailover(deadUrl, fallback.url);
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "syn:large:text" }) });
    assert.equal(response.status, 200, "a connection-level failure triggers the same failover");
    assert.equal(proxy.failovers()[0]?.status, undefined, "a connection error records no status");
    assert.equal(fallback.seen.length, 1);
  } finally {
    await proxy.close();
    await fallback.close();
  }

  const primary400 = await fakeUpstream((_req, _body, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad request" }));
  });
  const fallback400 = await fakeUpstream((_req, _body, res) => res.end());
  const noFailover = await proxyWithFailover(primary400.url, fallback400.url);
  try {
    const response = await fetch(`${noFailover.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "syn:large:text" }) });
    assert.equal(response.status, 400, "a client error is surfaced as-is");
    assert.equal(fallback400.seen.length, 0, "a 400 never reaches the fallback");
    assert.equal(noFailover.failovers().length, 0);
  } finally {
    await noFailover.close();
    await primary400.close();
    await fallback400.close();
  }
});

test("the fallback is terminal: a connection-error primary + a 429 fallback is not re-failed-over", async () => {
  const dead = await fakeUpstream((_req, _body, res) => res.end());
  const deadUrl = dead.url;
  await dead.close();
  const fallback = await fakeUpstream((_req, _body, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate limited" }));
  });
  const proxy = await proxyWithFailover(deadUrl, fallback.url);
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "syn:large:text" }) });
    assert.equal(response.status, 429, "the fallback's status is surfaced");
    assert.equal(fallback.seen.length, 1, "the fallback is attempted exactly once");
    assert.equal(proxy.failovers().length, 1, "only the connection-error failover is journalled");
  } finally {
    await proxy.close();
    await fallback.close();
  }
});

test("the primary-hop rewrite is scoped to chat completions; the messages lane is not re-serialized", async () => {
  const primary = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message" }));
  });
  const fallback = await fakeUpstream((_req, _body, res) => res.end());
  const proxy = await proxyWithFailover(primary.url, fallback.url);
  try {
    const messagesBody = JSON.stringify({ model: "openrouter/auto", messages: [] });
    await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: REQ, body: messagesBody });
    assert.equal(primary.seen[0]?.body, messagesBody, "the messages lane forwards byte-unchanged (no model rewrite)");
  } finally {
    await proxy.close();
    await primary.close();
    await fallback.close();
  }
});

test("both upstreams rate-limited: the fallback's 429 is surfaced, no loop", async () => {
  const limited = (res: http.ServerResponse) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate limited" }));
  };
  const primary = await fakeUpstream((_req, _body, res) => limited(res));
  const fallback = await fakeUpstream((_req, _body, res) => limited(res));
  const proxy = await proxyWithFailover(primary.url, fallback.url);
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "syn:large:text" }) });
    assert.equal(response.status, 429);
    assert.equal(primary.seen.length, 1, "the primary is tried once");
    assert.equal(fallback.seen.length, 1, "the fallback is tried once, never looping");
    assert.equal(proxy.failovers().length, 1);
  } finally {
    await proxy.close();
    await primary.close();
    await fallback.close();
  }
});

test("the primary-hop default rewrite maps openrouter/auto to the Synthetic model; explicit models pass through", async () => {
  const primary = await fakeUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const fallback = await fakeUpstream((_req, _body, res) => res.end());
  const proxy = await proxyWithFailover(primary.url, fallback.url);
  try {
    await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "openrouter/auto" }) });
    const first = JSON.parse(primary.seen[0]?.body ?? "{}") as { model?: string };
    assert.equal(first.model, "syn:large:text", "the composed auto-router default is mapped to a Synthetic model on the primary hop");

    await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "syn:small:text" }) });
    const second = JSON.parse(primary.seen[1]?.body ?? "{}") as { model?: string };
    assert.equal(second.model, "syn:small:text", "an explicit operator model passes through unchanged");
  } finally {
    await proxy.close();
    await primary.close();
    await fallback.close();
  }
});

test("without the composition a 429 stays single-upstream (no behavior change)", async () => {
  const primary = await fakeUpstream((_req, _body, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate limited" }));
  });
  const proxy = await createModelUsageProxy({ upstream: primary.url, apiKey: "OR_KEY" });
  try {
    const response = await fetch(`${proxy.url}/api/v1/chat/completions`, { method: "POST", headers: REQ, body: JSON.stringify({ model: "openrouter/auto" }) });
    assert.equal(response.status, 429, "no failover is attempted");
    assert.deepEqual(proxy.failovers(), []);
  } finally {
    await proxy.close();
    await primary.close();
  }
});
