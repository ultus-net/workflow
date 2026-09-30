import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { opencodeAcpArgs, opencodeMajorVersion } from "../src/integrations/acp-runtime.js";
import { AcpSubprocessClient, type AcpPermissionDecision, type AcpSessionConfig } from "../src/adapters/acp-subprocess.js";
import { METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import type { ModelFamily } from "../src/integrations/model-profile.js";
import {
  DEFAULT_OPENCODE_MODEL,
  OPENCODE_V2_METERED_PROVIDER_ID,
  globalOpencodeBinary,
  meteredOpencodeConfig,
  OPENCODE_V2_VENDOR_BUILTINS,
  v2BuiltinModelRef,
} from "../src/integrations/opencode-agent-config.js";

/**
 * Gated live probe for the W070a open-source vendor lane on opencode v2 over
 * the ACP subprocess client (PR #431's server-lane probe is the sibling).
 *
 * Gate: WORKFLOW_OPENCODE_V2_VENDORS_ACP=1. Skips without it.
 *
 * #431 routed each vendor through its v2 BUILT-IN provider
 * (OPENCODE_V2_VENDOR_BUILTINS) and live-proved the SERVER/HTTP lane (which
 * honors the config `model`). The ACP picker registration for those built-ins
 * was left inferred. Live-verified here on v2.0.10 (2026-09-30): the ACP model
 * picker validates `session/set_config_option` against the provider catalog,
 * and the built-in catalogs do NOT carry every pool model id — `deepseek-flash`
 * and `glm-5.3` are absent (GLM tops out at `glm-5.2`), while `kimi-k3` is
 * present. So the connector must pin a catalog-valid ref
 * ({@link v2BuiltinModelRef}): `deepseek/deepseek-flash` →
 * `deepseek/deepseek-v4-flash` (the vendor-accepted legacy id), `kimi-k3`
 * identity, and GLM (no faithful id) falls back to the metered Auto Router.
 *
 * This probe mirrors that connector behavior over the ACP subprocess client and
 * asserts both halves:
 *
 *   (a) the pinned ref is exposed in the session's `configOptions` model picker
 *       (and, for GLM, that the `zai` built-in's catalog models are exposed),
 *       and
 *   (b) a turn reaches the local mock with the placeholder bearer and the
 *       expected vendor model id — i.e. the pin routes the built-in through
 *       the proxy.
 *
 * ADVISORY: proves the vendor route resolves; it makes no enforcement claim.
 */
const gated = process.env.WORKFLOW_OPENCODE_V2_VENDORS_ACP === "1";
const binary = globalOpencodeBinary();

const VENDOR_MODEL: Readonly<Record<ModelFamily, string>> = {
  deepseek: "deepseek-flash",
  glm: "glm-5.3",
  kimi: "kimi-k3",
};

interface ProbeResult {
  readonly advertised: readonly string[];
  readonly pinned: string[];
  readonly mockRequests: number;
  readonly mockAuth: string | undefined;
  readonly mockBodyModel: string | undefined;
  readonly stopReason: string | undefined;
}

/** Collect every string a picker-ish structure exposes as a model ref. */
function collectRefs(node: unknown, into: Set<string>): void {
  if (typeof node === "string") return;
  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, into);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === "value" || key === "id" || key === "modelId") && typeof value === "string") into.add(value);
    collectRefs(value, into);
  }
}

async function probeVendor(family: ModelFamily): Promise<ProbeResult> {
  const builtin = OPENCODE_V2_VENDOR_BUILTINS[family];
  assert.ok(builtin !== undefined, `no v2 built-in mapped for ${family}`);
  const model = VENDOR_MODEL[family];

  const received: { auth: string | undefined; model: string | undefined }[] = [];
  const mock = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      let parsed: { model?: unknown } = {};
      try { parsed = JSON.parse(body) as { model?: unknown }; } catch { /* routing is asserted, not the body */ }
      const requestModel = typeof parsed.model === "string" ? parsed.model : undefined;
      received.push({ auth: req.headers.authorization, model: requestModel });
      // The ACP session streams tokens, so opencode requests an SSE chat
      // completion; answer in that shape (the server lane could use a plain
      // JSON body, the ACP lane cannot).
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created: 0,
          model: requestModel ?? model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "DONE" }, null));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const address = mock.address();
  assert.ok(address !== null && typeof address === "object", "mock upstream must bind a TCP port");
  const mockBase = `http://127.0.0.1:${address.port}`;

  const workspace = mkdtempSync(join(tmpdir(), "wf-v2-vendor-acp-ws-"));
  const configHome = mkdtempSync(join(tmpdir(), "wf-v2-vendor-acp-cfg-"));
  mkdirSync(join(configHome, "opencode"), { recursive: true });
  const config = meteredOpencodeConfig({
    proxyUrl: "http://127.0.0.1:1",
    opencodeMajor: 2,
    openSource: {
      providers: [{
        id: `workflow-${family}`,
        name: `Workflow metered (${family})`,
        baseURL: mockBase,
        models: { [model]: { name: model } },
        v2ProviderId: builtin.providerId,
      }],
      defaultModel: `workflow-${family}/${model}`,
    },
  });
  writeFileSync(join(configHome, "opencode", "opencode.json"), JSON.stringify(config));

  const major = await opencodeMajorVersion(binary as string);
  const child = spawn(binary as string, [...opencodeAcpArgs(major)], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: configHome,
      XDG_CONFIG_HOME: configHome,
      [builtin.envKey]: METERED_PLACEHOLDER_KEY,
    },
  });
  const client = new AcpSubprocessClient({
    child,
    resolvePermission: (): AcpPermissionDecision => ({ kind: "allow" }),
  });
  try {
    await client.initialize();
    const session = await client.newSession({ cwd: workspace });
    const advertised = new Set<string>();
    collectRefs(session.config.configOptions, advertised);

    // Mirror the connector's v2 pin (#427 + the catalog-valid translation).
    const connectorPin = v2BuiltinModelRef(String(config.model));
    // For a vendor built-in with no faithful catalog id (GLM), the connector
    // pins the metered Auto Router; the zai built-in is still exposed and
    // proxied, so prove routing by selecting one of its advertised models.
    const zaiOptions = [...advertised].filter((ref) => ref.startsWith(`${builtin.providerId}/`));
    const pin = connectorPin.startsWith(`${builtin.providerId}/`)
      ? connectorPin
      : zaiOptions[0];
    assert.ok(pin !== undefined, `no ACP model ref to pin for ${family} (advertised: ${JSON.stringify([...advertised])})`);

    const pinned = await client.setConfigOption({ sessionId: session.sessionId, configId: "model", value: pin });
    const pinnedRefs = new Set<string>();
    collectRefs((pinned as unknown as AcpSessionConfig).configOptions, pinnedRefs);

    const result = await Promise.race([
      client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly the word DONE and nothing else." }],
      }) as Promise<{ stopReason?: string }>,
      new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 90_000)),
    ]);

    return {
      advertised: [...advertised],
      pinned: [pin, ...pinnedRefs],
      mockRequests: received.length,
      mockAuth: received[0]?.auth,
      mockBodyModel: received[0]?.model,
      stopReason: result.stopReason,
    };
  } finally {
    await client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    mock.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
}

test(`open-source vendor deepseek's v2 built-in is picker-registered and routes an ACP turn through the proxy`, { skip: !gated || binary === undefined, timeout: 240_000 }, async () => {
  const major = binary === undefined ? undefined : await opencodeMajorVersion(binary);
  if (major === undefined || major < 2) { console.log(`skipping: ambient opencode major is ${String(major)} (probe targets v2)`); return; }
  const builtin = OPENCODE_V2_VENDOR_BUILTINS.deepseek!;
  const ref = v2BuiltinModelRef("deepseek/deepseek-flash");
  assert.equal(ref, "deepseek/deepseek-v4-flash");
  const result = await probeVendor("deepseek");
  console.log(JSON.stringify({ family: "deepseek", builtin: builtin.providerId, envKey: builtin.envKey, ref, ...result }, null, 2));
  assert.ok(result.advertised.includes(ref), `the ACP picker must advertise ${ref}; saw ${JSON.stringify(result.advertised)}`);
  assert.equal(result.mockAuth, `Bearer ${METERED_PLACEHOLDER_KEY}`, "the agent must present only the placeholder credential");
  assert.equal(result.mockBodyModel, "deepseek-v4-flash", "the catalog model id must be forwarded to the vendor proxy");
  assert.ok(result.mockRequests > 0, "the mock upstream must have observed model traffic");
  assert.equal(result.stopReason, "end_turn", "the pinned ACP turn must complete");
});

test(`open-source vendor kimi's v2 built-in is picker-registered and routes an ACP turn through the proxy`, { skip: !gated || binary === undefined, timeout: 240_000 }, async () => {
  const major = binary === undefined ? undefined : await opencodeMajorVersion(binary);
  if (major === undefined || major < 2) { console.log(`skipping: ambient opencode major is ${String(major)} (probe targets v2)`); return; }
  const builtin = OPENCODE_V2_VENDOR_BUILTINS.kimi!;
  const ref = v2BuiltinModelRef("moonshotai/kimi-k3");
  const result = await probeVendor("kimi");
  console.log(JSON.stringify({ family: "kimi", builtin: builtin.providerId, envKey: builtin.envKey, ref, ...result }, null, 2));
  assert.ok(result.advertised.includes(ref), `the ACP picker must advertise ${ref}; saw ${JSON.stringify(result.advertised)}`);
  assert.equal(result.mockAuth, `Bearer ${METERED_PLACEHOLDER_KEY}`, "the agent must present only the placeholder credential");
  assert.equal(result.mockBodyModel, "kimi-k3", "the vendor model id must be forwarded unchanged");
  assert.ok(result.mockRequests > 0, "the mock upstream must have observed model traffic");
  assert.equal(result.stopReason, "end_turn", "the pinned ACP turn must complete");
});

test(`open-source vendor glm's zai built-in is picker-registered and routes an ACP turn through the proxy`, { skip: !gated || binary === undefined, timeout: 240_000 }, async () => {
  const major = binary === undefined ? undefined : await opencodeMajorVersion(binary);
  if (major === undefined || major < 2) { console.log(`skipping: ambient opencode major is ${String(major)} (probe targets v2)`); return; }
  const builtin = OPENCODE_V2_VENDOR_BUILTINS.glm!;
  // v2.0.10's zai catalog has no glm-5.3; the connector faithfully falls back
  // to the metered Auto Router rather than downgrading to glm-5.2.
  assert.equal(v2BuiltinModelRef("zai/glm-5.3"), `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
  const result = await probeVendor("glm");
  console.log(JSON.stringify({ family: "glm", builtin: builtin.providerId, envKey: builtin.envKey, fallback: `${OPENCODE_V2_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`, ...result }, null, 2));
  const zaiAdvertised = result.advertised.filter((ref) => ref.startsWith("zai/"));
  assert.ok(zaiAdvertised.length > 0, `the zai built-in must be credential-activated and picker-registered; saw ${JSON.stringify(result.advertised)}`);
  assert.equal(result.mockAuth, `Bearer ${METERED_PLACEHOLDER_KEY}`, "the agent must present only the placeholder credential");
  assert.ok(result.mockBodyModel?.startsWith("glm"), `the selected zai catalog model must reach the vendor proxy; saw ${String(result.mockBodyModel)}`);
  assert.ok(result.mockRequests > 0, "the mock upstream must have observed model traffic");
  assert.equal(result.stopReason, "end_turn", "the pinned ACP turn must complete");
});
