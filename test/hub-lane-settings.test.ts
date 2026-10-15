import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hubLaneSettings } from "../src/integrations/hub-lane-settings.js";
import { defaultSettings, type WorkflowSettings } from "../src/integrations/workflow-settings.js";

/**
 * W198 (2026-10-15): the unattended-lane settings projection.
 *
 * Regression target: before W198, `src/cli/hub.ts` passed no `settings` to
 * `createConfiguredAcpRuntime` on the reviewer, RSI, and scheduler lanes, so
 * operator-enabled MCP connectors never reached a scheduled or RSI turn
 * (`acp-runtime.ts:411-420` derives the mount from `options.settings`). These
 * cases pin both halves of the fix: connectors DO reach the lane, and the
 * lane's model/compaction posture is NOT silently changed.
 */

function withSettingsFile(document: unknown, run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "wf-hub-lane-settings-"));
  try {
    mkdirSync(join(home, ".config", "workflow"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".config", "workflow", "settings.json"), JSON.stringify(document), "utf8");
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("hubLaneSettings carries operator MCP servers into the unattended lane", () => {
  const document: WorkflowSettings = {
    version: 1,
    mcpServers: [
      { name: "deep-research-mcp", enabled: true, transport: "stdio", command: "node", args: ["/opt/deep-research.js"] },
      { name: "disabled-mcp", enabled: false, transport: "stdio", command: "node", args: ["/opt/off.js"] },
    ],
    agents: {},
  };
  withSettingsFile(document, (home) => {
    const projected = hubLaneSettings({ home });
    assert.deepEqual(
      projected.mcpServers.map((server) => server.name),
      ["deep-research-mcp", "disabled-mcp"],
      "both entries survive projection so the downstream disable filter sees the operator's explicit disable",
    );
  });
});

test("hubLaneSettings does NOT leak the interactive model or compaction posture", () => {
  const document = {
    version: 1,
    mcpServers: [{ name: "research-mcp", enabled: true, transport: "stdio", command: "node", args: [] }],
    agents: { opencode: { model: "some/interactive-model", autoCompact: true } },
  };
  withSettingsFile(document, (home) => {
    const projected = hubLaneSettings({ home });
    assert.deepEqual(projected.agents, {}, "the unattended lane must not adopt the operator's interactive agent preferences");
    assert.equal(projected.mcpServers.length, 1, "the connector still crosses the seam");
  });
});

test("hubLaneSettings is fail-closed: absent settings file yields the default document", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-hub-lane-settings-empty-"));
  try {
    const projected = hubLaneSettings({ home });
    assert.deepEqual(projected, defaultSettings(), "no file means no operator connectors and no invented defaults");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hubLaneSettings applies the workspace overlay over the global base", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-hub-lane-settings-overlay-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-hub-lane-settings-ws-"));
  try {
    mkdirSync(join(home, ".config", "workflow"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, ".config", "workflow", "settings.json"),
      JSON.stringify({ version: 1, mcpServers: [{ name: "global-mcp", enabled: true, transport: "stdio", command: "node", args: [] }], agents: {} }),
      "utf8",
    );
    mkdirSync(join(workspace, ".workflow"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(workspace, ".workflow", "settings.json"),
      JSON.stringify({ version: 1, mcpServers: [{ name: "workspace-mcp", enabled: true, transport: "stdio", command: "node", args: [] }], agents: {} }),
      "utf8",
    );
    const projected = hubLaneSettings({ home, workspace });
    assert.deepEqual(
      projected.mcpServers.map((server) => server.name).sort(),
      ["global-mcp", "workspace-mcp"],
      "per-name merge keeps the global connector and adds the workspace overlay",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
