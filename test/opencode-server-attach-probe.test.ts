import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
 * W071 — gated live probe for the standard-TUI server topology (M1),
 * re-qualified for the stock v2 API (2026-09-20, W074 gap fix).
 *
 * Gated: WORKFLOW_OPENCODE_SERVER_ATTACH=1. Skips without the gate, mirroring
 * the `test/acp-*-probe.test.ts` family (no date-gating; the ambient opencode
 * version is recorded from `/api/info`).
 *
 * Stock v2 serves its web UI as an SPA fallback on every bare path — the JSON
 * API lives under `/api/*` — so this probe speaks the v2 spellings and
 * envelopes:
 *  - the hub-written config is the pinned `ask` ruleset (file) and the
 *    metered provider is visible to the real server (`/api/provider`);
 *  - the gateway passes the stock-client surface (`/api/info`,
 *    `/api/session` create, `/api/provider`, `/api/event` SSE);
 *  - the authority split holds (a TUI-only credential cannot reach upstream);
 *  - broker mode intercepts replies and never forwards a client reply upstream.
 *
 * Still advisory: the live `permission.asked` → authorize → reply path needs a
 * model key; no `enforced` claim is earned here.
 */
const gated = process.env.WORKFLOW_OPENCODE_SERVER_ATTACH === "1";
const binary = globalOpencodeBinary();

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("W071 live (v2 spellings): runtime + gateway authority split against real opencode", { skip: !gated || binary === undefined, timeout: 120_000 }, async (t) => {
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

  // The hub-written config file is the pinned ask ruleset…
  const configFile = JSON.parse(readFileSync(join(runtime.stateDir, "config", "opencode", "opencode.json"), "utf8")) as {
    permission?: Record<string, string>;
    provider?: Record<string, unknown>;
  };
  assert.deepEqual(configFile.permission, { edit: "ask", bash: "ask", task: "ask" });
  assert.notEqual(configFile.provider?.["workflow-metered"], undefined);
  // …and the real server loads it: the config document list includes the
  // hub-written config with the provider parsed. (v2.0.10 observation, per
  // docs/OPENCODE_V2_MIGRATION_SPEC.md §9: /api/provider lists
  // credential-activated providers only — a config-defined provider does NOT
  // appear there on the pinned release, matching the upstream custom-provider
  // visibility issue; the loaded-config assertion is the honest contract.)
  const configDocs = await fetch(`${runtime.url}/api/config`, { headers: upstreamHeaders });
  assert.equal(configDocs.status, 200, `upstream /api/config returned ${configDocs.status}`);
  const documents = (await configDocs.json() as readonly { type?: string; path?: string; info?: { providers?: Record<string, unknown> } }[]);
  const hubDocument = documents.find((entry) => entry.path !== undefined && entry.path.includes(join(runtime.stateDir, "config")));
  assert.ok(hubDocument !== undefined, "the hub-written config must be among the loaded documents");
  assert.notEqual(hubDocument.info?.providers?.["workflow-metered"], undefined, "the metered provider must be parsed into the loaded config");
  assert.ok(JSON.stringify(hubDocument.info ?? {}).includes("workflow-metered"), "the metered provider id must be in the loaded config document");

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

  // Stock-client surface through the gateway (v2 spellings).
  const gInfo = await fetch(`${gateway.url}/api/info`, { headers: tuiHeaders });
  assert.equal(gInfo.status, 200);
  assert.match((await gInfo.json() as { version?: unknown }).version as string, /^\d/, "the gateway must pass /api/info with a version");

  const gSession = await fetch(`${gateway.url}/api/session`, {
    method: "POST",
    headers: { ...tuiHeaders, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(gSession.status, 200);
  assert.equal(typeof (await gSession.json() as { data?: { id?: unknown } }).data?.id, "string", "the v2 session envelope must carry data.id");

  // The provider route forwards through the gateway as a documented read; the
  // response shape is the v2 envelope. (Provider VISIBILITY is not asserted —
  // see the §9 note: config-defined providers do not list on v2.0.10.)
  const gProviders = await fetch(`${gateway.url}/api/provider`, { headers: tuiHeaders });
  assert.equal(gProviders.status, 200);
  const gProviderBody = await gProviders.json() as { location?: unknown; data?: unknown };
  assert.ok(Array.isArray(gProviderBody.data), "the provider route must return the v2 envelope");

  const stream = await fetch(`${gateway.url}/api/event`, { headers: tuiHeaders, signal: AbortSignal.timeout(4_000) }).catch((error: unknown) => {
    throw new Error(`gateway SSE failed to open: ${error instanceof Error ? error.message : String(error)}`);
  });
  assert.ok(/text\/event-stream/.test(stream.headers.get("content-type") ?? ""), "gateway must pass through SSE");

  // Authority split.
  const replyPath = "/api/session/sess1/permission/req1/reply";
  const direct = await fetch(`${runtime.url}${replyPath}`, {
    method: "POST",
    headers: { ...tuiHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(direct.status, 401, "a gateway-only credential must never authorize upstream");

  const brokerReply = await fetch(`${gateway.url}${replyPath}`, {
    method: "POST",
    headers: { ...tuiHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reply: "reject" }),
  });
  assert.equal(brokerReply.status, 200);
  assert.deepEqual(intercepted, [{ sessionId: "sess1", requestId: "req1", reply: "reject" }]);

  const hubReply = await fetch(`${runtime.url}${replyPath}`, {
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
