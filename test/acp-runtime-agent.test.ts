import assert from "node:assert/strict";
import test from "node:test";

import { acpAgentKind } from "../src/integrations/acp-runtime.js";
import { METERED_PLACEHOLDER_KEY } from "../src/integrations/model-usage-proxy.js";
import {
  DEFAULT_OPENCODE_MODEL,
  OPENCODE_METERED_PROVIDER_ID,
  meteredOpencodeConfig,
  resolveOpencodeLaunch,
} from "../src/integrations/opencode-agent-config.js";

function withEnv(env: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("acpAgentKind defaults to opencode and selects the cline fallback explicitly", () => {
  withEnv({ WORKFLOW_ACP_AGENT: undefined }, () => {
    assert.equal(acpAgentKind(), "opencode");
  });
  withEnv({ WORKFLOW_ACP_AGENT: "" }, () => {
    assert.equal(acpAgentKind(), "opencode");
  });
  withEnv({ WORKFLOW_ACP_AGENT: "opencode" }, () => {
    assert.equal(acpAgentKind(), "opencode");
  });
  withEnv({ WORKFLOW_ACP_AGENT: "cline" }, () => {
    assert.equal(acpAgentKind(), "cline");
  });
  withEnv({ WORKFLOW_ACP_AGENT: "claude" }, () => {
    assert.throws(() => acpAgentKind(), /WORKFLOW_ACP_AGENT must be "opencode" or "cline"/);
  });
});

test("meteredOpencodeConfig points the agent at the proxy with only the placeholder credential", () => {
  const config = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61000" });
  const provider = (config.provider as Record<string, Record<string, unknown>>)[OPENCODE_METERED_PROVIDER_ID]!;
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(provider.options, {
    baseURL: "http://127.0.0.1:61000/api/v1",
    // opencode 1.18's config schema requires a plain string (verified live);
    // the placeholder is the only credential the config ever carries.
    apiKey: METERED_PLACEHOLDER_KEY,
  });
  assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
  const models = provider.models as Record<string, unknown>;
  assert.ok(DEFAULT_OPENCODE_MODEL in models, "the default model must be exposed through the provider");
  assert.deepEqual(config.permission, { edit: "ask", bash: "ask", task: "ask" });
});

test("meteredOpencodeConfig honors an explicit model override", () => {
  const config = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61001", model: "anthropic/claude-sonnet-4" });
  const provider = (config.provider as Record<string, Record<string, unknown>>)[OPENCODE_METERED_PROVIDER_ID]!;
  assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/anthropic/claude-sonnet-4`);
  assert.ok("anthropic/claude-sonnet-4" in (provider.models as Record<string, unknown>));
});

test("resolveOpencodeLaunch fails closed on missing override and missing PATH binary", () => {
  withEnv({ WORKFLOW_OPENCODE_BIN: undefined }, () => {
    assert.throws(
      () => resolveOpencodeLaunch({ opencodeOnPath: undefined }),
      /No OpenCode agent available/,
    );
  });
  assert.throws(
    () => resolveOpencodeLaunch({
      envBinOverride: "/nonexistent/opencode",
      exists: () => false,
    }),
    /WORKFLOW_OPENCODE_BIN points at a missing binary/,
  );
  const resolution = resolveOpencodeLaunch({
    envBinOverride: "/opt/opencode",
    exists: () => true,
    realpath: (p: string) => `/real:${p}`,
  });
  assert.equal(resolution.executable, "/real:/opt/opencode");
  assert.equal(resolveOpencodeLaunch({ opencodeOnPath: "/usr/bin/opencode" }).executable, "/usr/bin/opencode");
});
