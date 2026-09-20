import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProcessContainment } from "../src/containment/contracts.js";
import { globalOpencodeBinary } from "../src/integrations/opencode-agent-config.js";
import { createOpencodeServerRuntime } from "../src/integrations/opencode-server-runtime.js";
import { createOpencodeServerGateway } from "../src/integrations/opencode-server-gateway.js";
import type { ModelUsageProxy } from "../src/integrations/model-usage-proxy.js";

/**
 * W074a — gated live probe: the stock opencode web UI served THROUGH the
 * production route-class gateway in ENFORCED posture.
 *
 * Gated: WORKFLOW_OPENCODE_WEBUI_PROBE=1. Skips without the gate, mirroring
 * the `test/acp-*-probe.test.ts` family (no date-gating; the ambient opencode
 * version is recorded from `/api/info` for the docs/ verdict row).
 *
 * Qualifies (on the pinned stock server):
 *  - the app-shell route class actually serves the UI: `GET /` → `text/html`
 *    with a `/_assets/` bundle reference, the bundle itself → `text/javascript`;
 *  - auxiliary shell assets (`/site.webmanifest`, `/favicon.ico`) forward;
 *  - the authority boundary holds around it: unauthenticated `GET /` is 401 and
 *    an unknown root-level read is still 403 fail-closed (never forwarded);
 *  - the upstream config read stays denied through the gateway (the shell must
 *    not become a path to the credential-bearing config payload).
 */
const gated = process.env.WORKFLOW_OPENCODE_WEBUI_PROBE === "1";
const binary = globalOpencodeBinary();

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("W074a live: the stock opencode web UI serves through the enforced gateway", { skip: !gated || binary === undefined, timeout: 120_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-webui-probe-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-webui-probe-state-"));
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

  const info = await fetch(`${runtime.url}/api/info`, { headers: { authorization: basic(runtime.username, runtime.password) } });
  const serverVersion = info.ok ? ((await info.json() as { version?: string }).version ?? "unknown") : `info ${info.status}`;
  console.log(`opencode-webui-gateway-probe: stock server version ${serverVersion}`);

  const gateway = await createOpencodeServerGateway({
    upstream: runtime.url,
    upstreamUsername: runtime.username,
    upstreamPassword: runtime.password,
    tuiPassword: "webui-probe-password",
    enforced: true,
    // Enforced posture requires the broker hook; no live permission event
    // fires without a model key, so the interception list stays empty here —
    // the broker decision path itself is pinned by the gateway unit suite.
    onPermissionReply: () => {},
  });
  t.after(() => void gateway.close());
  const clientHeaders = { authorization: basic(runtime.username, "webui-probe-password") };

  // Authority boundary first: without credentials nothing of the shell shows.
  const unauthenticated = await fetch(`${gateway.url}/`);
  assert.equal(unauthenticated.status, 401, "the app shell must sit behind gateway auth");

  // The app shell forwards and is HTML.
  const shell = await fetch(`${gateway.url}/`, { headers: clientHeaders });
  assert.equal(shell.status, 200, `GET / through the enforced gateway returned ${shell.status}`);
  const shellType = shell.headers.get("content-type") ?? "";
  assert.ok(shellType.startsWith("text/html"), `the app shell must be text/html (got ${shellType})`);
  const shellBody = await shell.text();

  // The referenced hashed bundle forwards as JavaScript.
  const bundleRef = /\/_assets\/[^"']+\.js/.exec(shellBody)?.[0];
  assert.ok(bundleRef !== undefined, "the app shell must reference a /_assets/ bundle");
  const bundle = await fetch(new URL(bundleRef, gateway.url), { headers: clientHeaders });
  assert.equal(bundle.status, 200, `the hashed bundle ${bundleRef} returned ${bundle.status}`);
  assert.ok((bundle.headers.get("content-type") ?? "").startsWith("text/javascript"), "the bundle must be JavaScript");

  // Auxiliary shell assets forward.
  const manifest = await fetch(`${gateway.url}/site.webmanifest`, { headers: clientHeaders });
  assert.equal(manifest.status, 200, "the web manifest must forward");

  // Fail-closed neighbors: an unknown root read is never forwarded…
  const unknownRead = await fetch(`${gateway.url}/not-a-real-route.js`, { headers: clientHeaders });
  assert.equal(unknownRead.status, 403, "an unclassified root read must fail closed in enforced posture");
  // …and the shell must not open a path to the credential-bearing config.
  const configRead = await fetch(`${gateway.url}/api/config`, { headers: clientHeaders });
  assert.equal(configRead.status, 403, "the config read stays denied through the gateway (review P3)");
});
