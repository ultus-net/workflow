import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProcessContainment } from "../src/containment/contracts.js";
import { globalOpencodeBinary } from "../src/integrations/opencode-agent-config.js";
import type { ModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import { createSessionCompactionMonitor } from "../src/integrations/opencode-server-monitor.js";
import { createOpencodeServerRuntime } from "../src/integrations/opencode-server-runtime.js";

/**
 * W082 — gated live probe for the CONFIG-SIDE automatic compaction trigger.
 *
 * Gated: WORKFLOW_OPENCODE_AUTO_COMPACT_PROBE=1 (skips without it, mirroring
 * the probe family; the ambient server version is recorded from /api/info).
 *
 * The design decision recorded for W082 (the §9 addendum, 2026-09-20): the
 * hub-side automatic trigger is the hub-written config itself — the session
 * runtime auto-compacts on its own at the documented threshold exactly when
 * the model's compaction config enables it (`compaction: { auto: true }`,
 * per-model runtime behavior on the session stream, NOT the HTTP route).
 * No plugin hook is composed (W082 excludes `ctx.session.hook("compaction")`),
 * and there is no prompt-side loop: the operator opt-in
 * (`agents.opencode.autoCompact`) reaches the runtime through the same
 * hub-written per-runtime config every other composed surface rides, and the
 * metering/budget posture is unchanged (a compaction turn is a normal
 * metered model turn through the loopback proxy).
 *
 * What this probe qualifies without a real model turn:
 *  1. The composed config file carries `compaction: { auto: true }` beside
 *     the pinned ask ruleset — the deterministic gate is IN the runtime's
 *     hands, nothing prompt-side, no plugin.
 *  2. The real server LOADED that config: the config document list includes
 *     the hub-written document with the compaction block parsed (the same
 *     loaded-config contract the M1 probe pins for the provider).
 *
 * What this probe deliberately does NOT claim (recorded PENDING in
 * docs/PROBE_VERDICTS.json): that a real model turn overflowing the context
 * actually auto-compacts on the pinned version — a live auto-compact turn
 * needs a real model key, exactly like the W071 live permission arm. No
 * `enforced` claim is earned by this file alone.
 */

const gated = process.env.WORKFLOW_OPENCODE_AUTO_COMPACT_PROBE === "1";
const describe = gated ? test : test.skip;

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("W082 live: the config-side auto-compaction trigger reaches the pinned runtime", { skip: gated && globalOpencodeBinary() === undefined, timeout: 120_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-autocompact-probe-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-autocompact-probe-state-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(stateHome, { recursive: true, force: true }); });

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
    autoCompact: true,
    healthTimeoutMs: 30_000,
  });
  t.after(() => runtime.dispose());

  // 1. The hub-written config file carries the composed trigger next to the
  // pinned ask ruleset — the trigger is config-owned, not a plugin or a
  // prompt-side loop.
  const configFile = JSON.parse(readFileSync(join(runtime.stateDir, "config", "opencode", "opencode.json"), "utf8")) as {
    permission?: Record<string, string>;
    compaction?: { auto?: boolean };
    provider?: Record<string, unknown>;
  };
  assert.deepEqual(configFile.compaction, { auto: true }, "the composed config carries compaction: { auto: true }");
  assert.deepEqual(configFile.permission, { edit: "ask", bash: "ask", task: "ask", skill: "deny" }, "the trigger composes alongside the authority ruleset (including the single-delivery-path skill denial), never instead of it");

  const upstreamHeaders = { authorization: basic(runtime.username, runtime.password) };

  // The ambient pinned version is recorded, per the probe discipline.
  const info = await fetch(`${runtime.url}/api/info`, { headers: upstreamHeaders });
  assert.equal(info.ok, true, "the stock server must answer /api/info");
  const infoBody = await info.json() as { version?: string } | undefined;
  console.log(`opencode-auto-compact-probe: stock server version ${infoBody?.version ?? "unknown"}`);

  // 2. The real server loaded the hub-written config document with the
  // compaction block parsed — the same loaded-config contract the M1 probe
  // pins for the metered provider (v2.0.10: /api/config lists documents; a
  // config-defined provider does not appear in /api/provider, so the
  // loaded-config assertion is the honest contract).
  const configDocs = await fetch(`${runtime.url}/api/config`, { headers: upstreamHeaders });
  assert.equal(configDocs.status, 200, `upstream /api/config returned ${configDocs.status}`);
  const documents = await configDocs.json() as readonly { path?: string; info?: Record<string, unknown> }[];
  const hubDocument = documents.find((entry) => entry.path !== undefined && entry.path.includes(join(runtime.stateDir, "config")));
  assert.notEqual(hubDocument, undefined, "the hub-written config document must be among the loaded documents");
  const loaded = hubDocument?.info as { compaction?: { auto?: boolean } } | undefined;
  assert.equal(loaded?.compaction?.auto, true, "the loaded config carries compaction.auto === true — the runtime owns the deterministic trigger");

  // Honest PENDING arm (not asserted): a real model turn that overflows the
  // context and auto-compacts needs real model credentials; until that arm
  // runs, the register records this family PENDING and no enforced claim is
  // made for the runtime's auto-compaction behavior itself.
  console.log("opencode-auto-compact-probe: config-load arm green; the live auto-compact turn arm stays PENDING (needs a real model turn — docs/PROBE_VERDICTS.json)");
});

describe("W082 live: the data-lane compaction monitor reads the documented session state", { skip: gated && globalOpencodeBinary() === undefined, timeout: 120_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-compact-monitor-ws-"));
  const stateHome = mkdtempSync(join(tmpdir(), "wf-compact-monitor-state-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(stateHome, { recursive: true, force: true }); });

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
  const headers = { authorization: `Basic ${Buffer.from(`${runtime.username}:${runtime.password}`).toString("base64")}`, "content-type": "application/json" };

  // A probe session through the documented route (the M1 spellings); it has
  // no turns, so its usage is 0 — the monitor must evaluate it and NOT fire.
  const created = await fetch(`${runtime.url}/api/session`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(created.status, 200, `session create returned ${created.status}`);
  const createdBody = await created.json().catch(() => undefined) as { data?: { id?: string } } | undefined;
  const createdId = createdBody?.data?.id;
  assert.ok(createdId !== undefined && createdId.startsWith("ses"), "the documented create returns the v2 data.id envelope");

  // Pin the usage-read shape the monitor depends on: the session entry on
  // the documented list carries the `tokens` object (the same shape the
  // runtime's own overflow check uses). Without this pin the tick would
  // pass even if entries carried no tokens at all — the monitor would read
  // zero for every session and never fire.
  const list = await fetch(`${runtime.url}/api/session`, { headers });
  assert.equal(list.status, 200, `session list returned ${list.status}`);
  const listBody = await list.json() as { data?: readonly unknown[] } | undefined;
  const entry = (listBody?.data ?? []).find((entry) => (entry as { id?: string }).id === createdId) as Record<string, unknown> | undefined;
  assert.notEqual(entry, undefined, "the created session must appear on the documented list");
  const tokens = entry?.tokens as Record<string, unknown> | undefined;
  assert.ok(typeof tokens === "object" && tokens !== null, "the session entry carries the tokens object the monitor reads");
  assert.ok(typeof tokens.input === "number" && typeof tokens.output === "number" && typeof (tokens.cache as Record<string, unknown> | undefined)?.read === "number", "the tokens shape has input/output and cache.read — the overflow-total fields");

  // The monitor's deterministic tick against the LIVE server: the usage read
  // rides the session entries' tokens (live-verified shape), the empty
  // session is below any threshold, so the honest result is evaluated ≥ 1
  // and zero fires — the read path is qualified; the FIRE path against a
  // real overflow turn stays PENDING (needs a real model turn).
  const monitor = createSessionCompactionMonitor({
    baseUrl: runtime.url,
    username: runtime.username,
    password: runtime.password,
    thresholdTokens: 1_000,
  });
  const result = await monitor.tick();
  assert.equal(result.errors.length, 0, `the monitor tick must be clean: ${JSON.stringify(result.errors)}`);
  assert.ok(result.evaluated >= 1, `the monitor must evaluate the created session (evaluated ${result.evaluated})`);
  assert.deepEqual(result.fired, [], "an empty session is below the threshold — never a fire");
  assert.equal(result.skipped.length, 0, "below-threshold sessions re-arm silently, no skip noise");
  console.log(`opencode-auto-compact-probe: monitor read arm green (evaluated ${result.evaluated}, fired 0); the fire path stays PENDING on a real model turn`);
});