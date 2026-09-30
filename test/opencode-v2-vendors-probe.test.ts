import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { opencodeMajorVersion } from "../src/integrations/acp-runtime.js";
import { METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import type { ModelFamily } from "../src/integrations/model-profile.js";
import { globalOpencodeBinary, meteredOpencodeConfig, OPENCODE_V2_VENDOR_BUILTINS } from "../src/integrations/opencode-agent-config.js";

/**
 * Gated live probe for the W070a open-source vendor lane on opencode v2.
 *
 * Gate: WORKFLOW_OPENCODE_V2_VENDORS=1. Skips without it.
 *
 * v2 does not register a config-defined custom provider (#427), so the vendors
 * ride their v2 BUILT-IN providers (OPENCODE_V2_VENDOR_BUILTINS). This probe
 * builds the ACTUAL emitted `meteredOpencodeConfig` (opencodeMajor: 2, an
 * open-source pool), points each vendor's proxy baseURL at a local mock
 * upstream, launches the real `opencode serve` with only the vendor's
 * placeholder env key, creates a session, prompts it, and asserts the session
 * ran on the vendor's BUILT-IN provider id and that the mock received the
 * placeholder bearer. It proves the config shape + env activation route the
 * vendor, not the config-defined custom-provider path v2 ignores.
 *
 * ADVISORY: proves the vendor route resolves; it makes no enforcement claim.
 */
const gated = process.env.WORKFLOW_OPENCODE_V2_VENDORS === "1";
const binary = globalOpencodeBinary();

const VENDOR_MODEL: Readonly<Record<ModelFamily, string>> = {
  deepseek: "deepseek-flash",
  glm: "glm-5.3",
  kimi: "kimi-k3",
};

interface ProbeResult {
  readonly providerID: string | undefined;
  readonly modelID: string | undefined;
  readonly mockRequests: number;
  readonly mockAuth: string | undefined;
}

async function probeVendor(family: ModelFamily): Promise<ProbeResult> {
  const builtin = OPENCODE_V2_VENDOR_BUILTINS[family];
  assert.ok(builtin !== undefined, `no v2 built-in mapped for ${family}`);
  const model = VENDOR_MODEL[family];

  const received: { auth: string | undefined }[] = [];
  const mock = createServer((req, res) => {
    req.resume(); // drain the request body; only routing/activation is asserted
    req.on("end", () => {
      received.push({ auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion",
        created: 0,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "DONE" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const address = mock.address();
  assert.ok(address !== null && typeof address === "object", "mock upstream must bind a TCP port");
  const mockBase = `http://127.0.0.1:${address.port}`;

  const workspace = mkdtempSync(join(tmpdir(), "wf-v2-vendor-ws-"));
  const configHome = mkdtempSync(join(tmpdir(), "wf-v2-vendor-cfg-"));
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
  // The pin under test: the emitted config routes the vendor through its built-in.
  assert.equal(config.model, `${builtin.providerId}/${model}`);
  writeFileSync(join(configHome, "opencode", "opencode.json"), JSON.stringify(config));

  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(binary as string, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      XDG_CONFIG_HOME: configHome,
      OPENCODE_SERVER_PASSWORD: "vendor-probe",
      OPENCODE_SERVER_USERNAME: "opencode",
      [builtin.envKey]: METERED_PLACEHOLDER_KEY,
    },
  });
  try {
    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { out += String(chunk); });
    const auth = `Basic ${Buffer.from("opencode:vendor-probe").toString("base64")}`;
    let urlBase = "";
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const match = /listening on (https?:\/\/\S+)/.exec(out);
      if (match?.[1] !== undefined) { urlBase = match[1]; break; }
      if (child.exitCode !== null) throw new Error(`opencode serve exited early: ${out.slice(0, 1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.notEqual(urlBase, "", `opencode serve did not report a URL: ${out.slice(0, 1000)}`);
    const q = (path: string): string => `${urlBase}${path}?directory=${encodeURIComponent(workspace)}`;

    const created = await fetch(q("/api/session"), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "vendor-probe" }),
    });
    assert.equal(created.status, 200, `session create returned ${created.status}`);
    const sessionId = (await created.json() as { data?: { id?: unknown } }).data?.id;
    assert.equal(typeof sessionId, "string", "the v2 session envelope must carry data.id");

    const prompted = await fetch(q(`/api/session/${sessionId}/prompt`), {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "Reply with exactly the word DONE and nothing else." }),
    });
    assert.equal(prompted.status, 200, `prompt returned ${prompted.status}`);

    let assistant: { model?: { providerID?: string; id?: string } } | undefined;
    const pollDeadline = Date.now() + 120_000;
    while (Date.now() < pollDeadline) {
      const messages = await fetch(q(`/api/session/${sessionId}/message`), { headers: { authorization: auth } });
      const data = (await messages.json() as { data?: readonly { type?: string; model?: { providerID?: string; id?: string } }[] }).data ?? [];
      const foundAssistant = data.find((message) => message.type === "assistant");
      const idle = data.find((message) => message.type === "idle");
      if (foundAssistant !== undefined) assistant = foundAssistant;
      if (idle !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return {
      providerID: assistant?.model?.providerID,
      modelID: assistant?.model?.id,
      mockRequests: received.length,
      mockAuth: received[0]?.auth,
    };
  } finally {
    child.kill("SIGKILL");
    mock.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
}

for (const family of ["deepseek", "glm", "kimi"] as const) {
  test(`open-source vendor ${family} routes through its v2 built-in provider to the proxy`, { skip: !gated || binary === undefined, timeout: 240_000 }, async () => {
    const major = binary === undefined ? undefined : await opencodeMajorVersion(binary);
    if (major === undefined || major < 2) {
      console.log(`skipping: ambient opencode major is ${String(major)} (probe targets v2)`);
      return;
    }
    const result = await probeVendor(family);
    const builtin = OPENCODE_V2_VENDOR_BUILTINS[family]!;
    console.log(JSON.stringify({ family, builtin: builtin.providerId, envKey: builtin.envKey, ...result }, null, 2));
    assert.equal(result.providerID, builtin.providerId, "the session must run on the vendor's v2 built-in provider");
    assert.equal(result.modelID, VENDOR_MODEL[family], "the vendor model id must be forwarded unchanged");
    assert.ok(result.mockRequests > 0, "the mock upstream must have observed model traffic");
    assert.equal(result.mockAuth, `Bearer ${METERED_PLACEHOLDER_KEY}`, "the agent must present only the placeholder credential");
  });
}
