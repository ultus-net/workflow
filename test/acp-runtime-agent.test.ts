import assert from "node:assert/strict";
import test from "node:test";

import { acpAgentKind, openrouterAuthKeyFromAuth, resolveSkillsMountFor } from "../src/integrations/acp-runtime.js";
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
  withEnv({ WORKFLOW_ACP_AGENT: "goose" }, () => {
    assert.equal(acpAgentKind(), "goose");
  });
  withEnv({ WORKFLOW_ACP_AGENT: "claude" }, () => {
    assert.throws(() => acpAgentKind(), /WORKFLOW_ACP_AGENT must be "opencode", "cline", or "goose"/);
  });
});

test("OpenCode auth fallback only accepts a non-empty OpenRouter key", () => {
  assert.equal(openrouterAuthKeyFromAuth({ openrouter: { key: " or-key " } }), "or-key");
  assert.equal(openrouterAuthKeyFromAuth({ openrouter: { key: "   " } }), undefined);
  assert.equal(openrouterAuthKeyFromAuth({ openrouter: { type: "oauth" } }), undefined);
  assert.equal(openrouterAuthKeyFromAuth({ anthropic: { key: "other-key" } }), undefined);
  assert.equal(openrouterAuthKeyFromAuth(null), undefined);
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

test("meteredOpencodeConfig exposes the alias pool as selectable models with the Auto Router default", () => {
  const config = meteredOpencodeConfig({
    proxyUrl: "http://localhost:61003",
    autoLatest: { aliases: ["~anthropic/claude-sonnet-latest", "~openai/gpt-terra-latest"] },
  });
  const provider = (config.provider as Record<string, Record<string, unknown>>)[OPENCODE_METERED_PROVIDER_ID]!;
  const models = provider.models as Record<string, { name: string }>;
  assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/${DEFAULT_OPENCODE_MODEL}`);
  assert.deepEqual(models[DEFAULT_OPENCODE_MODEL], { name: "Auto Router" });
  assert.deepEqual(models["~anthropic/claude-sonnet-latest"], { name: "Claude Sonnet (latest)" });
  assert.deepEqual(models["~openai/gpt-terra-latest"], { name: "GPT Terra (latest)" });
});

test("meteredOpencodeConfig keeps an explicit non-pool model selectable alongside the pool", () => {
  const config = meteredOpencodeConfig({
    proxyUrl: "http://localhost:61004",
    model: "anthropic/claude-sonnet-4",
    autoLatest: { aliases: ["~anthropic/claude-sonnet-latest"] },
  });
  const provider = (config.provider as Record<string, Record<string, unknown>>)[OPENCODE_METERED_PROVIDER_ID]!;
  const models = provider.models as Record<string, { name: string }>;
  assert.equal(config.model, `${OPENCODE_METERED_PROVIDER_ID}/anthropic/claude-sonnet-4`);
  assert.deepEqual(models["anthropic/claude-sonnet-4"], { name: "anthropic/claude-sonnet-4" });
  assert.ok("~anthropic/claude-sonnet-latest" in models, "the pool is exposed even with a custom default");
});

test("meteredOpencodeConfig mounts the skills delivery path only when composed", () => {
  const withoutSkills = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61002" });
  assert.equal("mcp" in withoutSkills, false, "no skills mount means no mcp block");
  const withSkills = meteredOpencodeConfig({
    proxyUrl: "http://127.0.0.1:61002",
    skills: { serverScript: "/repo/mcp-toolbox/apps/skills-mcp/dist/server.js", skillsDir: "/home/op/.agents/skills" },
  });
  const mcp = withSkills.mcp as Record<string, Record<string, unknown>>;
  const mount = mcp["skills-mcp"]!;
  assert.equal(mount.type, "local");
  assert.deepEqual(mount.command, [process.execPath, "/repo/mcp-toolbox/apps/skills-mcp/dist/server.js"]);
  assert.deepEqual(mount.environment, { SKILLS_MCP_DIR: "/home/op/.agents/skills" });
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

test("resolveSkillsMountFor composes the delivery mount from the shared skills dir semantics", () => {
  const exists = (path: string) =>
    path === "/repo/mcp-toolbox/apps/skills-mcp/dist/server.js" ||
    path === "/home/op/.agents/skills" ||
    path === "/srv/skills";
  const base = { root: "/repo", home: "/home/op", exists };
  // Default: SKILLS_MCP_DIR absent → ~/.agents/skills (the same default
  // skills-mcp and the hub's pedagogy gating use).
  assert.deepEqual(resolveSkillsMountFor({ ...base, envSkillsDir: undefined }), {
    serverScript: "/repo/mcp-toolbox/apps/skills-mcp/dist/server.js",
    skillsDir: "/home/op/.agents/skills",
  });
  // Explicit override wins.
  assert.equal(resolveSkillsMountFor({ ...base, envSkillsDir: "/srv/skills" })?.skillsDir, "/srv/skills");
  // Whitespace-only override falls to the default, mirroring the gating
  // resolver's trim semantics.
  assert.equal(resolveSkillsMountFor({ ...base, envSkillsDir: "   " })?.skillsDir, "/home/op/.agents/skills");
  // Missing server build or missing skills dir compose to no mount.
  assert.equal(resolveSkillsMountFor({ ...base, envSkillsDir: undefined, exists: () => false }), undefined);
  const noDir = (path: string) => path === "/repo/mcp-toolbox/apps/skills-mcp/dist/server.js";
  assert.equal(resolveSkillsMountFor({ ...base, envSkillsDir: undefined, exists: noDir }), undefined);
});
