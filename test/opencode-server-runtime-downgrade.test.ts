import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createModelUsageProxy, METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import {
  createOpencodeServerRuntime,
  type OpencodeServerProxyInput,
} from "../src/integrations/opencode-server-runtime.js";

/**
 * P15 wiring breadth (issue #294): the W118 budget-downgrade consumer + the
 * P15(a) auto-lane narrowing variant are composed into the opencode-server
 * runtime's proxy too — the recorded unwired site joins the ACP lane. These
 * pins capture the proxy-input the runtime hands its factory (the composition
 * boundary, the exact object the default factory forwards to
 * `createModelUsageProxy`) and then replay that input through the real proxy
 * to prove the lane rules and the metering posture.
 */

const TARGET = "z-ai/glm-5.3-flash";
const ALIASES = ["~deepseek/deepseek-flash-latest", "~z-ai/glm-latest"];
const CATALOG = {
  data: [
    { id: "~deepseek/deepseek-flash-latest", alias_target: { slug: "deepseek/deepseek-v4-flash" } },
    { id: "~z-ai/glm-latest", alias_target: { slug: "z-ai/glm-5.3" } },
  ],
};

/** Runs the runtime with an injected factory that captures its input, then
 *  aborts before the launch (the factory boundary is the seam under test, so
 *  no binary, containment, or health poll is needed). */
async function captureProxyInput(env: Record<string, string>): Promise<OpencodeServerProxyInput> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  Object.assign(process.env, env);
  let captured: OpencodeServerProxyInput | undefined;
  try {
    await assert.rejects(
      createOpencodeServerRuntime({
        workspace: "/tmp/p15-wiring-breadth-ws",
        stateHome: "/tmp/p15-wiring-breadth-state",
        upstream: "https://openrouter.ai",
        apiKey: "test-key-not-used",
        createProxy: async (input) => {
          captured = input;
          throw new Error("captured: stop before launch");
        },
      }),
      /captured: stop before launch/,
    );
  } finally {
    for (const key of Object.keys(env)) {
      const prior = saved[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }
  assert.ok(captured !== undefined, "the runtime must compose a proxy input");
  return captured;
}

interface FakeUpstream {
  readonly url: string;
  readonly seen: { url?: string; body?: string }[];
  close(): Promise<void>;
}

async function fakeUpstream(handler: (req: http.IncomingMessage, _body: Buffer, res: http.ServerResponse) => void): Promise<FakeUpstream> {
  const seen: FakeUpstream["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ ...(req.url === undefined ? {} : { url: req.url }), body: Buffer.concat(chunks).toString("utf8") });
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

interface Forwarded {
  model?: string;
  plugins?: Array<{ id?: string; allowed_models?: string[] }>;
  usage?: { include?: boolean };
}
const chatSeen = (upstream: FakeUpstream): { url?: string; body?: string }[] => upstream.seen.filter((entry) => entry.url === "/api/v1/chat/completions");
const parseForwarded = (upstream: FakeUpstream, index: number): Forwarded =>
  JSON.parse(chatSeen(upstream)[index]?.body ?? "{}") as Forwarded;

// ── The composition boundary ────────────────────────────────────────────────

test("P15 wiring: the server runtime composes the W118 downgrade axes + the autoLatest seam", async () => {
  const input = await captureProxyInput({
    WORKFLOW_BUDGET_DOWNGRADE_MODEL: TARGET,
    WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "0.5",
    WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "1000",
    WORKFLOW_OPENROUTER_AUTO_ALIASES: ALIASES.join(","),
  });
  assert.deepEqual(input.budgetDowngrade, {
    targetModel: TARGET,
    fraction: 0.5,
    budget: { maxTotalTokens: 1000 },
  }, "the runtime hands the factory the same axes + budget the ACP lane composes");
  assert.deepEqual(input.autoLatest?.aliases, ALIASES, "the autoLatest seam is composed proxy-side too (the P15(a) narrowing point)");
});

test("P15 wiring: no budget caps means no downgrade (nothing to warn about)", async () => {
  const input = await captureProxyInput({
    WORKFLOW_BUDGET_DOWNGRADE_MODEL: TARGET,
    WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "0.5",
    WORKFLOW_OPENROUTER_AUTO_ALIASES: ALIASES.join(","),
  });
  assert.equal(input.budgetDowngrade, undefined, "a downgrade without a budget has no warn tier");
  assert.deepEqual(input.autoLatest?.aliases, ALIASES, "the autoLatest seam survives; the lanes stay as-found");
});

test("P15 wiring: a malformed downgrade axis fails closed to no downgrade", async () => {
  const input = await captureProxyInput({
    WORKFLOW_BUDGET_DOWNGRADE_MODEL: TARGET,
    WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "1.5",
    WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "1000",
    WORKFLOW_OPENROUTER_AUTO_ALIASES: ALIASES.join(","),
  });
  assert.equal(input.budgetDowngrade, undefined, "fail-closed: a broken fraction composes no downgrade (W122 posture)");
  assert.deepEqual(input.autoLatest?.aliases, ALIASES, "the malformed axis never widens the lanes; they stay as-found");
});

// ── The lane rules through the composed proxy ───────────────────────────────

test("P15 wiring: the composed proxy narrows the auto lane and rewrites the concrete lane", async () => {
  const captureEnv = {
    WORKFLOW_BUDGET_DOWNGRADE_MODEL: TARGET,
    WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "0.5",
    WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "1000",
    WORKFLOW_OPENROUTER_AUTO_ALIASES: ALIASES.join(","),
  };
  const input = await captureProxyInput(captureEnv);
  const usageHolder = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 };
  const upstream = await fakeUpstream((req, _body, res) => {
    if (req.url?.endsWith("/api/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(CATALOG));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { ...usageHolder } }));
  });
  // The default factory forwards the captured input verbatim; replaying it
  // through the real proxy proves the runtime's composition drives the rules.
  const proxy = await createModelUsageProxy({ ...input, upstream: upstream.url });
  const ask = async (model: string): Promise<void> => {
    await fetch(`${proxy.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model, messages: [] }),
    });
  };
  try {
    await ask("openrouter/auto"); // 20 recorded: under the 500 warn fraction
    usageHolder.total_tokens = 900;
    await ask("openrouter/auto"); // lag: still under at request time, 900 now recorded
    await ask("openrouter/auto"); // crossed: the auto lane narrows, staying on the router
    const auto = parseForwarded(upstream, 2);
    assert.equal(auto.model, "openrouter/auto", "the auto lane keeps the router (P15(a) narrowing, not a model switch)");
    assert.deepEqual(auto.plugins?.[0]?.allowed_models, [TARGET], "the injected allowed_models narrows to exactly the target");
    await ask("z-ai/glm-5.3"); // the concrete lane keeps the W118 rewrite
    assert.equal(parseForwarded(upstream, 3).model, TARGET, "the concrete lane keeps the W118 body.model rewrite");

    // Metering unchanged: every request is metered identically across the
    // narrowing, and the usage-accounting injection survives it.
    const metrics = proxy.metrics();
    assert.equal(metrics.requests, 4, "all four requests metered");
    assert.equal(metrics.usageEvents, 4, "all four usage events recorded");
    assert.equal(metrics.totalTokens, 20 + 900 + 900 + 900, "the trail accumulates real usage across the narrowing");
    assert.deepEqual(parseForwarded(upstream, 2).usage, { include: true }, "the narrowed request still asks for usage accounting");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
