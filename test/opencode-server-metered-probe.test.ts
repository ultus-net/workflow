import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProcessContainment } from "../src/containment/contracts.js";
import { globalOpencodeBinary } from "../src/integrations/opencode-agent-config.js";
import { autoLatestConfigFromEnv } from "../src/integrations/openrouter-auto-latest.js";
import { createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import { createOpencodeServerRuntime } from "../src/integrations/opencode-server-runtime.js";
import { loadClineApiKey } from "./cline-probe-helpers.js";

/**
 * Gated live probe for the SERVER/topology lane's metered route on opencode v2
 * (the counterpart of test/acp-opencode-metered-probe.test.ts, PR #427).
 *
 * Gate: WORKFLOW_OPENCODE_SERVER_METERED=1. Skips without it (no date-gating;
 * the ambient opencode version is recorded from /api/info).
 *
 * It proves the version-aware daemon config routes a v2 HTTP session through
 * the loopback metering proxy: the runtime writes the v2
 * `providers`/`package`/`settings` shape reusing the built-in `openrouter`
 * provider, activates it with the placeholder `OPENROUTER_API_KEY` env var
 * (contained with a cleared environment, so the real key stays proxy-side), and
 * the config `model` IS honored for `POST /api/session` on v2.0.10 — so one
 * prompt produces proxy-observed requests/usage. This is the server-lane pin
 * (unlike ACP, which needed an explicit `session/set_config_option`).
 *
 * ADVISORY: proves the metered route resolves and meters; it makes no
 * enforcement claim.
 */
const gated = process.env.WORKFLOW_OPENCODE_SERVER_METERED === "1";
const binary = globalOpencodeBinary();

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("OpenCode server/topology metered proxy: v2 HTTP session routes through the hub proxy", { skip: !gated || binary === undefined, timeout: 240_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-srv-metered-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-srv-metered-state-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(stateHome, { recursive: true, force: true }); });
  if (binary === undefined) throw new Error("no opencode binary to probe");

  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  const upstreamKey = await loadClineApiKey("OpenCode server metered probe");
  const autoLatest = autoLatestConfigFromEnv({ upstream });
  const proxy = await createModelUsageProxy({
    upstream,
    apiKey: upstreamKey,
    ...(autoLatest === undefined ? {} : { autoLatest }),
  });
  // The runtime owns the injected proxy and closes it in dispose().

  // Cleared-environment boundary (the bwrap posture): only the runtime's own
  // environment crosses in, so an ambient provider key can never leak and the
  // placeholder-only claim is real.
  const boundary: ProcessContainment = {
    isolation: "enforced",
    async execute() { throw new Error("not used"); },
    spawn(request) {
      return spawn(request.executable, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...request.environment },
      });
    },
  };

  const runtime = await createOpencodeServerRuntime({
    workspace,
    stateHome,
    containment: boundary,
    apiKey: "test-key-not-used",
    createProxy: async () => proxy,
    healthTimeoutMs: 60_000,
  });
  t.after(() => runtime.dispose());

  const auth = { authorization: basic(runtime.username, runtime.password), "content-type": "application/json" };
  const q = (path: string): string => `${runtime.url}${path}?directory=${encodeURIComponent(workspace)}`;
  const created = await fetch(q("/api/session"), { method: "POST", headers: auth, body: JSON.stringify({ title: "metered-probe" }) });
  assert.equal(created.status, 200, `session create returned ${created.status}`);
  const sessionId = (await created.json() as { data?: { id?: unknown } }).data?.id;
  assert.equal(typeof sessionId, "string", "the v2 session envelope must carry data.id");

  const prompted = await fetch(q(`/api/session/${sessionId}/prompt`), {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: "Reply with exactly the word DONE and nothing else." }),
  });
  assert.equal(prompted.status, 200, `prompt returned ${prompted.status}`);

  // Poll the session messages until the assistant turn settles.
  let assistantModel: { providerID?: string; id?: string } | undefined;
  let assistantText = "";
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const messages = await fetch(q(`/api/session/${sessionId}/message`), { headers: { authorization: auth.authorization } });
    const data = (await messages.json() as { data?: readonly { type?: string; model?: { providerID?: string; id?: string }; content?: readonly { type?: string; text?: string }[] }[] }).data ?? [];
    const assistant = data.find((message) => message.type === "assistant");
    const idle = data.find((message) => message.type === "idle");
    if (assistant !== undefined) {
      assistantModel = assistant.model;
      assistantText = (assistant.content ?? []).map((part) => part.text ?? "").join("");
    }
    if (idle !== undefined) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  const metrics = proxy.metrics();
  console.log(JSON.stringify({
    agent: "OpenCode",
    version: runtime.version,
    lane: "server/topology",
    agentCredential: "placeholder-only",
    assistantModel,
    assistantText,
    metrics,
  }, null, 2));

  assert.equal(assistantModel?.providerID, "openrouter", "the session must run on the metered built-in openrouter provider");
  assert.ok(metrics.requests > 0, "the proxy must have observed model traffic");
  assert.ok(metrics.usageEvents > 0, "the proxy must have recorded usage accounting");
  assert.ok(metrics.totalTokens > 0, "the proxy must have counted tokens for the session");
});
