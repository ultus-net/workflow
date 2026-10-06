import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 *  no binary, containment, or health poll is needed). `upstream` is forwarded
 *  when given (omitted exercises the env/default lane selection). HOME is
 *  redirected to an empty temp dir and every lane env arm is cleared:
 *  `resolveRuntimeMeteredLane` reads `WORKFLOW_ACP_UPSTREAM`, the Synthetic
 *  env toggle/key, and the auth store and `~/.config/workflow/synthetic-api-key`
 *  files under `homedir()`, so without this isolation these lane pins would
 *  assert the HOST's state — a machine with a connected Synthetic key or an
 *  exported `WORKFLOW_ACP_UPSTREAM` would false-fail the "no key" case. */
async function captureProxyInput(env: Record<string, string>, upstream?: string): Promise<OpencodeServerProxyInput> {
  const LANE_ENV = ["SYNTHETIC_API_KEY", "WORKFLOW_SYNTHETIC", "WORKFLOW_ACP_UPSTREAM", "HOME"];
  const isolated = [...LANE_ENV, ...Object.keys(env)];
  const saved: Record<string, string | undefined> = {};
  for (const key of isolated) saved[key] = process.env[key];
  const emptyHome = mkdtempSync(join(tmpdir(), "wf-lane-home-"));
  let captured: OpencodeServerProxyInput | undefined;
  try {
    process.env.HOME = emptyHome;
    for (const key of LANE_ENV) if (key !== "HOME") delete process.env[key];
    Object.assign(process.env, env);
    await assert.rejects(
      createOpencodeServerRuntime({
        workspace: "/tmp/p15-wiring-breadth-ws",
        stateHome: "/tmp/p15-wiring-breadth-state",
        ...(upstream === undefined ? {} : { upstream }),
        apiKey: "test-key-not-used",
        createProxy: async (input) => {
          captured = input;
          throw new Error("captured: stop before launch");
        },
      }),
      /captured: stop before launch/,
    );
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    for (const key of isolated) {
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

// ── The Synthetic lane composition (the operator pivot) ─────────────────────

test("Synthetic lane: a resolvable Synthetic key composes the pair on the server runtime", async () => {
  const input = await captureProxyInput({ SYNTHETIC_API_KEY: "syn-test-key" });
  assert.equal(input.upstream, "https://api.synthetic.new", "the Synthetic key makes Synthetic the primary upstream");
  assert.equal(input.apiKey, "syn-test-key", "the primary key is the Synthetic key");
  assert.equal(input.syntheticFailover?.fallback, "https://openrouter.ai", "the fallback is OpenRouter");
  assert.equal(input.syntheticFailover?.fallbackApiKey, "test-key-not-used", "the fallback key is the OpenRouter upstream key");
  assert.equal(typeof input.syntheticFailover?.onFailover, "function", "the runtime sink is wired with the failover mapping");
});

test("Synthetic lane: WORKFLOW_SYNTHETIC=0 leaves the server runtime single-upstream OpenRouter", async () => {
  const input = await captureProxyInput({ SYNTHETIC_API_KEY: "syn-test-key", WORKFLOW_SYNTHETIC: "0" });
  assert.equal(input.upstream, "https://openrouter.ai", "the off toggle disables the pair; the lane stays OpenRouter");
  assert.equal(input.apiKey, "test-key-not-used", "the OpenRouter key rides the single lane");
  assert.equal(input.syntheticFailover, undefined, "no pair is composed when disabled");
});

test("Synthetic lane: no Synthetic key keeps the server runtime single-upstream OpenRouter", async () => {
  const input = await captureProxyInput({});
  assert.equal(input.upstream, "https://openrouter.ai", "with no Synthetic key the lane is unchanged");
  assert.equal(input.syntheticFailover, undefined, "the failover seam is absent without the pair");
});

test("Synthetic lane: an explicit upstream is never overridden by the Synthetic key", async () => {
  // A NON-default explicit upstream: a default-equal value could not
  // distinguish "option forwarded verbatim" from "the Synthetic key was
  // silently unresolvable", so this pin is self-sufficient.
  const input = await captureProxyInput({ SYNTHETIC_API_KEY: "syn-test-key" }, "https://explicit.example.test");
  assert.equal(input.upstream, "https://explicit.example.test", "an explicit upstream option always wins");
  assert.equal(input.apiKey, "test-key-not-used", "a non-Synthetic configured upstream takes the OpenRouter key");
  assert.equal(input.syntheticFailover, undefined, "the pair composes only for a Synthetic primary");
});
