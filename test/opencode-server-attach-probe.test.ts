import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProcessContainment } from "../src/containment/contracts.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { globalOpencodeBinary } from "../src/integrations/opencode-agent-config.js";
import { createOpencodeServerAuthority } from "../src/integrations/opencode-server-authority.js";
import {
  createOpencodeServerGateway,
  type OpencodePermissionReply,
} from "../src/integrations/opencode-server-gateway.js";
import type { ModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import { createOpencodeServerRuntime } from "../src/integrations/opencode-server-runtime.js";
import { HttpRemoteEngine } from "../src/integrations/remote-acp/engine.js";

/**
 * W071 — gated live probe for the standard-TUI server topology (M1).
 *
 * Gated: WORKFLOW_OPENCODE_SERVER_ATTACH=1. Skips without the gate, mirroring
 * the `test/acp-*-probe.test.ts` family (no date-gating; the ambient opencode
 * version is recorded from `/global/health`).
 *
 * Exercises the PRODUCTION runtime + gateway, with a boundary double that runs
 * the real `opencode serve` directly (no Bubblewrap/model key required here):
 *  - the hub-written config is read and the `ask` ruleset is in force;
 *  - the gateway passes the stock-client surface (health/session/providers/SSE);
 *  - the authority split holds (a TUI-only credential cannot reach upstream);
 *  - broker mode intercepts replies and never forwards a client reply upstream.
 */
const gated = process.env.WORKFLOW_OPENCODE_SERVER_ATTACH === "1";
const binary = globalOpencodeBinary();

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function withDirectory(url: string, directory: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("directory", directory);
  return parsed.toString();
}

test("W071 live: runtime + gateway authority split against real opencode", { skip: !gated || binary === undefined, timeout: 120_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-m1-probe-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-m1-probe-state-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(stateHome, { recursive: true, force: true }); });
  if (binary === undefined) throw new Error("no opencode binary to probe");

  const boundary: ProcessContainment = {
    isolation: "enforced",
    async execute() { throw new Error("not used"); },
    spawn(request) {
      return spawn(request.executable, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { ...process.env, ...request.environment },
      });
    },
  };
  const proxy = {
    url: "http://127.0.0.1:9/api/v1",
    metrics: () => ({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }),
    close: async () => undefined,
  } as unknown as ModelUsageProxy;

  const runtime = await createOpencodeServerRuntime({
    workspace,
    stateHome,
    containment: boundary,
    apiKey: "test-key-not-used",
    createProxy: async () => proxy,
    model: "openrouter/auto",
    healthTimeoutMs: 30_000,
  });
  t.after(() => runtime.dispose());

  const upstreamHeaders = { authorization: basic(runtime.username, runtime.password) };
  const dir = (url: string) => withDirectory(url, workspace);

  // The hub-written config is read; the ask ruleset is pinned.
  const config = await fetch(dir(`${runtime.url}/config`), { headers: upstreamHeaders });
  assert.equal(config.status, 200);
  const configBody = await config.json() as { permission?: Record<string, string>; provider?: Record<string, unknown> };
  assert.deepEqual(configBody.permission, { edit: "ask", bash: "ask", task: "ask" });
  assert.notEqual(configBody.provider?.["workflow-metered"], undefined);

  // Broker mode: replies are intercepted by the production gateway.
  const intercepted: OpencodePermissionReply[] = [];
  const gateway = await createOpencodeServerGateway({
    upstream: runtime.url,
    upstreamUsername: runtime.username,
    upstreamPassword: runtime.password,
    tuiPassword: "tui-probe-password",
    onPermissionReply: (reply) => { intercepted.push(reply); },
  });
  t.after(() => void gateway.close());
  const tuiHeaders = { authorization: basic(runtime.username, "tui-probe-password") };

  // Stock-client surface through the gateway.
  const gHealth = await fetch(dir(`${gateway.url}/global/health`), { headers: tuiHeaders });
  assert.equal(gHealth.status, 200);
  assert.equal((await gHealth.json() as { healthy?: unknown }).healthy, true);
  const gSession = await fetch(dir(`${gateway.url}/session`), {
    method: "POST",
    headers: { ...tuiHeaders, "content-type": "application/json", "x-opencode-directory": workspace },
    body: JSON.stringify({}),
  });
  assert.equal(gSession.status, 200);
  assert.equal(typeof (await gSession.json() as { id?: unknown }).id, "string");
  const gProviders = await fetch(dir(`${gateway.url}/config/providers`), { headers: tuiHeaders });
  assert.equal(gProviders.status, 200);
  const providerIds = ((await gProviders.json() as { providers?: readonly { id?: string }[] }).providers ?? []).map((entry) => entry.id);
  assert.ok(providerIds.includes("workflow-metered"), `metered provider not visible through the gateway: ${providerIds.join(",")}`);

  const stream = await fetch(dir(`${gateway.url}/global/event`), { headers: tuiHeaders, signal: AbortSignal.timeout(4_000) }).catch((error: unknown) => {
    throw new Error(`gateway SSE failed to open: ${error instanceof Error ? error.message : String(error)}`);
  });
  assert.ok(/text\/event-stream/.test(stream.headers.get("content-type") ?? ""), "gateway must pass through SSE");

  // Authority split.
  const replyPath = "/api/session/sess1/permission/req1/reply";
  const direct = await fetch(dir(`${runtime.url}${replyPath}`), {
    method: "POST",
    headers: { ...tuiHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(direct.status, 401, "a gateway-only credential must never authorize upstream");

  const brokerReply = await fetch(dir(`${gateway.url}${replyPath}`), {
    method: "POST",
    headers: { ...tuiHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(brokerReply.status, 200);
  assert.deepEqual(intercepted, [{ sessionId: "sess1", requestId: "req1", reply: "reject" }]);

  const hubReply = await fetch(dir(`${runtime.url}${replyPath}`), {
    method: "POST",
    headers: { ...upstreamHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.notEqual(hubReply.status, 401);
  assert.notEqual(hubReply.status, 403);

  // M2: the authority broker subscribes to the real server's SSE through the
  // production engine and stays subscribed (no model key here, so no live
  // permission event fires; the policy path is pinned by the unit suite).
  const authority = createOpencodeServerAuthority({
    engine: new HttpRemoteEngine({
      baseUrl: runtime.url,
      cwd: workspace,
      username: runtime.username,
      password: runtime.password,
    }),
    application: new WorkflowApplication(
      new TaskGraph([]),
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation", "process"]),
      workspace,
    ),
    workspace,
  });
  void authority.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.equal(authority.authorityLost, false, "broker SSE subscription must be live against the real server");
  await authority.stop();

  console.log(`[W071 live] opencode ${runtime.version ?? "unknown"}: runtime + gateway live; ruleset pinned; authority split holds; broker subscribed; gateway intercepted ${intercepted.length} reply`);
});