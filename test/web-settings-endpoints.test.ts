import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  TaskGraph,
  WorkflowApplication,
  createWorkflowWebServer,
  hostCapabilities,
} from "../src/index.js";
import {
  normalizeSettings,
  readSettingsFile,
  settingsPaths,
  writeSettingsFile,
} from "../src/integrations/workflow-settings.js";
import { opencodeServerWorkspaceTag } from "../src/integrations/opencode-server-runtime.js";
import { writeOpencodeServerDiscovery } from "../src/integrations/opencode-server-discovery.js";

/** Starts the web server against a throwaway home + workspace so the settings
 * files never touch the operator's real config. */
async function startServer(context: TestContext): Promise<{ base: string; home: string; workspace: string }> {
  const home = mkdtempSync(join(tmpdir(), "wf-web-mcp-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-web-mcp-ws-"));
  context.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, undefined, undefined, { home, workspace });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, home, workspace };
}

const serverEntry = (name: string, enabled = true): Record<string, unknown> => ({
  name,
  enabled,
  transport: "stdio",
  command: "node",
  args: ["server.js"],
});

test("MCP catalog: read defaults, write the workspace overlay, and merge with global", async (context) => {
  const { base, home, workspace } = await startServer(context);
  const paths = settingsPaths({ home, workspace });

  const empty = await fetch(`${base}/api/settings/mcp`).then((response) => response.json()) as {
    servers: unknown[]; workspaceOverlay: boolean;
  };
  assert.deepEqual(empty.servers, []);
  assert.equal(empty.workspaceOverlay, true);

  const write = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "workspace", servers: [serverEntry("workspace-tools")] }),
  });
  assert.equal(write.status, 200);
  assert.deepEqual(readSettingsFile(paths.workspace!).mcpServers.map((entry) => entry.name), ["workspace-tools"]);

  // A global server is seeded directly, then the effective read merges both.
  writeSettingsFile(paths.global, normalizeSettings({ mcpServers: [serverEntry("global-tools")] }));
  const merged = await fetch(`${base}/api/settings/mcp`).then((response) => response.json()) as {
    servers: { name: string }[]; global: { name: string }[]; workspace: { name: string }[];
  };
  assert.deepEqual(merged.servers.map((entry) => entry.name).sort(), ["global-tools", "workspace-tools"]);
  assert.deepEqual(merged.global.map((entry) => entry.name), ["global-tools"]);
  assert.deepEqual(merged.workspace.map((entry) => entry.name), ["workspace-tools"]);
});

test("MCP catalog: workspace scope wins on name conflict", async (context) => {
  const { base, home, workspace } = await startServer(context);
  const paths = settingsPaths({ home, workspace });
  writeSettingsFile(paths.global, normalizeSettings({ mcpServers: [{ ...serverEntry("shared"), command: "global-command" }] }));
  writeSettingsFile(paths.workspace!, normalizeSettings({ mcpServers: [{ ...serverEntry("shared"), command: "workspace-command" }] }));
  const merged = await fetch(`${base}/api/settings/mcp`).then((response) => response.json()) as {
    servers: { name: string; command: string }[];
  };
  assert.equal(merged.servers.filter((entry) => entry.name === "shared").length, 1);
  assert.equal(merged.servers.find((entry) => entry.name === "shared")?.command, "workspace-command");
});

test("MCP catalog: rejects cross-origin, non-JSON, and malformed bodies", async (context) => {
  const { base } = await startServer(context);

  const crossOrigin = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ scope: "workspace", servers: [] }),
  });
  assert.equal(crossOrigin.status, 403);

  const noJson = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "nope",
  });
  assert.equal(noJson.status, 415);

  const badServers = await fetch(`${base}/api/settings/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "workspace", servers: "not-an-array" }),
  });
  assert.equal(badServers.status, 400);
});

test("agent preferences persist as launch defaults and merge per key", async (context) => {
  const { base, home, workspace } = await startServer(context);

  const first = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "opencode", preference: { model: "openrouter/auto" } }),
  });
  assert.equal(first.status, 200);
  const second = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "opencode", preference: { mode: "plan" } }),
  });
  assert.equal(second.status, 200);

  const stored = readSettingsFile(settingsPaths({ home, workspace }).workspace!);
  assert.deepEqual(stored.agents.opencode, { model: "openrouter/auto", mode: "plan" });

  const missing = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "opencode", preference: {} }),
  });
  assert.equal(missing.status, 400);
});

test("agent routing GET merges scopes and reports environment facts without secrets", async (context) => {
  const { base, home, workspace } = await startServer(context);

  const seed = await fetch(`${base}/api/settings/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "goose", preference: { model: "goose/seeded" } }),
  });
  assert.equal(seed.status, 200);
  writeSettingsFile(settingsPaths({ home, workspace }).global, normalizeSettings({
    agents: { goose: { mode: "build" }, opencode: { model: "openrouter/auto" } },
  }));

  // The upstream fact must echo the operator-set env var; every presence
  // boolean's inputs are isolated so the exact values are pinned, not ambient.
  const envSnapshot: readonly [string, string | undefined][] = [
    ["WORKFLOW_ACP_UPSTREAM", process.env.WORKFLOW_ACP_UPSTREAM],
    ["WORKFLOW_OPENCODE_MODEL", process.env.WORKFLOW_OPENCODE_MODEL],
    ["WORKFLOW_GOOSE_MODEL", process.env.WORKFLOW_GOOSE_MODEL],
    ["GOOSE_MODEL", process.env.GOOSE_MODEL],
    ["AZURE_FOUNDRY_MODEL", process.env.AZURE_FOUNDRY_MODEL],
    ["WORKFLOW_OPENROUTER_MANAGEMENT_KEY", process.env.WORKFLOW_OPENROUTER_MANAGEMENT_KEY],
  ];
  process.env.WORKFLOW_ACP_UPSTREAM = "https://example-upstream.test";
  for (const [name] of envSnapshot.slice(1)) delete process.env[name];
  context.after(() => {
    for (const [name, value] of envSnapshot) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const read = await fetch(`${base}/api/settings/agents`).then((response) => response.json()) as {
    agents: Record<string, Record<string, string>>;
    facts: Record<string, unknown>;
  };

  // Workspace (just persisted) merges over global per key.
  assert.equal(read.agents.goose?.model, "goose/seeded");
  assert.equal(read.agents.goose?.mode, "build");
  assert.equal(read.agents.opencode?.model, "openrouter/auto");

  assert.equal(read.facts.envModelOpencode, false, "env model was deleted; the panel default must apply");
  assert.equal(read.facts.envModelGoose, false, "all goose model env inputs were deleted");
  assert.equal(read.facts.managementKey, false, "the management key env input was deleted");
});

test("live MCP endpoint: honest unavailable states without a topology daemon", async (context) => {
  const { base, workspace } = await startServer(context);
  const stateHome = mkdtempSync(join(tmpdir(), "wf-live-endpoint-"));
  context.after(() => rmSync(stateHome, { recursive: true, force: true }));

  // No discovery at all: the reason is the value — never a fabricated list.
  const previous = process.env.WORKFLOW_OPENCODE_SERVER_HOME;
  process.env.WORKFLOW_OPENCODE_SERVER_HOME = stateHome;
  context.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_OPENCODE_SERVER_HOME;
    else process.env.WORKFLOW_OPENCODE_SERVER_HOME = previous;
  });
  const empty = await fetch(`${base}/api/settings/mcp/live`).then((response) => response.json()) as { live: boolean; reason?: string };
  assert.equal(empty.live, false);
  assert.match(empty.reason ?? "", /no server topology daemon/);

  // A discovery pointing at an unbound port: the probe fails honestly. The
  // endpoint keys discovery by the service's own workspace.
  writeOpencodeServerDiscovery(join(stateHome, `${opencodeServerWorkspaceTag(workspace)}.json`), {
    protocol: 1,
    pid: process.pid,
    workspace,
    gatewayUrl: "http://127.0.0.1:1",
    tuiUsername: "opencode",
    tuiPassword: "endpoint-test-password",
  });
  const dead = await fetch(`${base}/api/settings/mcp/live`).then((response) => response.json()) as { live: boolean; reason?: string };
  assert.equal(dead.live, false);
  assert.match(dead.reason ?? "", /did not answer/);
});

// The "schedules endpoint" test was removed in the merge with main: the
// /api/schedules surface is main's hub proxy (live schedule registry with
// save/delete/run-now, pinned by the hub-proxy endpoint tests on main), which
// supersedes this branch's read-only file-table read.
