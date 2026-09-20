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
 * W082 — gated live probe: operator-triggered manual compaction through the
 * production route-class gateway in ENFORCED posture.
 *
 * Gated: WORKFLOW_OPENCODE_COMPACT_PROBE=1. Skips without the gate, mirroring
 * the `test/acp-*-probe.test.ts` family (the ambient opencode version is
 * recorded from `/api/info` for the docs/ verdict row).
 *
 * Qualifies (on the pinned stock server):
 *  - the documented `POST /api/session` creates a probe session through the
 *    enforced gateway (the compact route needs a real session id, `^ses`);
 *  - `POST /api/session/{id}/compact` is classified `forward` and the server
 *    answers honestly: per the documented contract the route durably ADMITS a
 *    compaction request (`{ data: Session.Inbox.Compaction }`), and on an
 *    empty session the server's own `compaction.unavailable`
 *    ("Nothing to compact yet") is the honest outcome — the probe pins the
 *    envelope shape either way and records which one the pinned version
 *    produced;
 *  - unauthenticated compact stays 401 behind gateway auth.
 */
const gated = process.env.WORKFLOW_OPENCODE_COMPACT_PROBE === "1";
const binary = globalOpencodeBinary();

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("W082 live: operator-triggered compaction rides the enforced gateway", { skip: !gated || binary === undefined, timeout: 120_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-compact-probe-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-compact-probe-state-"));
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
  console.log(`opencode-compact-probe: stock server version ${serverVersion}`);

  const gateway = await createOpencodeServerGateway({
    upstream: runtime.url,
    upstreamUsername: runtime.username,
    upstreamPassword: runtime.password,
    tuiPassword: "compact-probe-password",
    enforced: true,
    onPermissionReply: () => {},
  });
  t.after(() => void gateway.close());
  const clientHeaders = { authorization: basic(runtime.username, "compact-probe-password"), "content-type": "application/json" };

  // Authority boundary: an unauthenticated compact is 401, never forwarded.
  const unauthenticated = await fetch(`${gateway.url}/api/session/ses_nonexistent/compact`, { method: "POST" });
  assert.equal(unauthenticated.status, 401, "the compact route must sit behind gateway auth");

  // A real probe session through the gateway (documented POST /api/session).
  const created = await fetch(`${gateway.url}/api/session`, { method: "POST", headers: clientHeaders, body: JSON.stringify({}) });
  assert.equal(created.status, 200, `POST /api/session through the enforced gateway returned ${created.status}`);
  const createdBody = await created.json() as { data?: { id?: string } };
  const sessionId = createdBody.data?.id;
  assert.ok(sessionId !== undefined && sessionId.startsWith("ses"), "the created session id must match the documented ^ses shape");

  // The compact route forwards; both honest outcomes are pinned by shape.
  const compact = await fetch(`${gateway.url}/api/session/${sessionId}/compact`, { method: "POST", headers: clientHeaders, body: JSON.stringify({}) });
  const compactBody = await compact.json().catch(() => undefined) as { data?: { id?: string; type?: string; message?: string } } | undefined;
  if (compact.status === 200) {
    assert.ok(compactBody?.data?.id !== undefined && compactBody.data.id.startsWith("msg_"), "an admitted compaction request returns the documented inbox item");
    assert.equal(compactBody?.data?.type, "compaction", "the admitted item is a compaction request (queued, runs at the next step boundary)");
    console.log("opencode-compact-probe: compaction admitted (queued at the next step boundary)");
  } else {
    assert.ok(
      compact.status === 400 || compact.status === 404 || compact.status === 409,
      `the compact route answered ${compact.status} — expected the documented 200 admit or a 4xx client error`,
    );
    assert.ok(compactBody !== undefined, "the refusal carries the server's error envelope");
    console.log(`opencode-compact-probe: server refused honestly (${compact.status}) — the pinned empty-session outcome`);
  }
});
