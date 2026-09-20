import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clineMcpServers,
  defaultSettings,
  enabledMcpServers,
  gooseExtensionLines,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  opencodeMcpServers,
  settingsPaths,
  writeSettingsFile,
} from "../src/integrations/workflow-settings.js";
import { meteredOpencodeConfig, opencodeSettingsConfig } from "../src/integrations/opencode-agent-config.js";

test("normalizeSettings fails closed on malformed documents", () => {
  assert.deepEqual(normalizeSettings(undefined), defaultSettings());
  assert.deepEqual(normalizeSettings("nope"), defaultSettings());
  assert.deepEqual(normalizeSettings({ version: 1, mcpServers: "nope", agents: 7 }), defaultSettings());

  const normalized = normalizeSettings({
    mcpServers: [
      { name: "good", transport: "stdio", command: "node", args: ["server.js"], env: { A: "1" } },
      { name: "remote", transport: "http", url: "https://mcp.example/mcp" },
      { name: "", transport: "stdio", command: "node" },
      { name: "no-transport", command: "node" },
      { name: "no-command", transport: "stdio" },
      { name: "no-url", transport: "http" },
      { name: "disabled", transport: "stdio", command: "node", enabled: false },
    ],
    agents: {
      opencode: { model: "openrouter/auto", mode: "build" },
      empty: {},
      bad: "nope",
    },
  });
  assert.deepEqual(normalized.mcpServers.map((server) => server.name), ["good", "remote", "disabled"]);
  assert.equal(normalized.mcpServers[0]?.enabled, true);
  assert.equal(normalized.mcpServers[2]?.enabled, false);
  assert.deepEqual(normalized.agents, { opencode: { model: "openrouter/auto", mode: "build" } });
});

test("mergeSettings overlays per server name and per agent key", () => {
  const base = normalizeSettings({
    mcpServers: [{ name: "a", transport: "stdio", command: "base" }],
    agents: { opencode: { model: "base-model", mode: "build" } },
  });
  const overlay = normalizeSettings({
    mcpServers: [{ name: "a", transport: "stdio", command: "overlay" }, { name: "b", transport: "http", url: "https://x" }],
    agents: { opencode: { model: "overlay-model" }, goose: { model: "g" } },
  });
  const merged = mergeSettings(base, overlay);
  assert.equal(merged.mcpServers.find((server) => server.name === "a")?.command, "overlay");
  assert.deepEqual(merged.mcpServers.map((server) => server.name).sort(), ["a", "b"]);
  assert.deepEqual(merged.agents.opencode, { model: "overlay-model", mode: "build" });
  assert.deepEqual(merged.agents.goose, { model: "g" });
});

test("loadSettings applies workspace overlay over the global base", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-settings-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-settings-ws-"));
  try {
    const paths = settingsPaths({ home, workspace });
    writeSettingsFile(paths.global, normalizeSettings({
      mcpServers: [{ name: "global", transport: "stdio", command: "g" }],
      agents: { opencode: { model: "global-model" } },
    }));
    writeSettingsFile(paths.workspace!, normalizeSettings({
      mcpServers: [{ name: "local", transport: "http", url: "https://local" }],
      agents: { opencode: { mode: "plan" } },
    }));
    const loaded = loadSettings({ home, workspace });
    assert.deepEqual(loaded.mcpServers.map((server) => server.name).sort(), ["global", "local"]);
    assert.deepEqual(loaded.agents.opencode, { model: "global-model", mode: "plan" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a corrupt settings file yields defaults, never throws", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-settings-corrupt-"));
  try {
    writeFileSync(join(home, "settings.json"), "{ not json", "utf8");
    assert.deepEqual(loadSettings({ home }), defaultSettings());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("projections cover stdio and http for opencode, cline, and goose", () => {
  const servers = normalizeSettings({
    mcpServers: [
      { name: "tools", transport: "stdio", command: "node", args: ["s.js"], env: { K: "v" } },
      { name: "web", transport: "http", url: "https://mcp.example/mcp" },
      { name: "off", transport: "stdio", command: "node", enabled: false },
    ],
  }).mcpServers.filter((server) => server.enabled);

  const opencode = opencodeMcpServers(servers) as Record<string, Record<string, unknown>>;
  assert.deepEqual(opencode.tools, { type: "local", command: ["node", "s.js"], environment: { K: "v" } });
  assert.deepEqual(opencode.web, { type: "remote", url: "https://mcp.example/mcp" });
  assert.equal("off" in opencode, false);

  const cline = clineMcpServers(servers) as Record<string, Record<string, unknown>>;
  assert.deepEqual(cline.tools, { type: "stdio", command: "node", args: ["s.js"], env: { K: "v" } });
  assert.deepEqual(cline.web, { type: "http", url: "https://mcp.example/mcp" });

  const goose = gooseExtensionLines(servers);
  assert.ok(goose.includes("  tools:"));
  assert.ok(goose.includes("  web:"));
  assert.ok(goose.some((line) => line.includes('uri: "https://mcp.example/mcp"')));
  assert.ok(goose.some((line) => line.includes('K: "v"')));
});

test("opencode launch projection pushes the operator MCP catalog and model preference", () => {
  assert.deepEqual(opencodeSettingsConfig(undefined), {});

  const settings = normalizeSettings({
    mcpServers: [
      { name: "tools", transport: "stdio", command: "node", args: ["s.js"] },
      { name: "off", transport: "stdio", command: "node", enabled: false },
    ],
    agents: { opencode: { model: "openrouter/auto-fast" } },
  });
  const config = opencodeSettingsConfig(settings);
  assert.equal(config.model, "openrouter/auto-fast");
  const mcp = config.mcp as Record<string, unknown>;
  assert.deepEqual(mcp.tools, { type: "local", command: ["node", "s.js"] });
  assert.equal("off" in mcp, false, "disabled servers never reach the agent config");

  // The metered path merges operator servers alongside the skills mount.
  const metered = meteredOpencodeConfig({
    proxyUrl: "http://127.0.0.1:1",
    mcpServers: enabledMcpServers(settings),
    skills: { serverScript: "/toolbox/skills.js", skillsDir: "/skills" },
  });
  const meteredMcp = metered.mcp as Record<string, unknown>;
  assert.ok("tools" in meteredMcp);
  assert.ok("skills-mcp" in meteredMcp);
});

