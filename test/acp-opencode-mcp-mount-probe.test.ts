import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient, type AcpSessionUpdate } from "../src/adapters/acp-subprocess.js";

/**
 * OpenCode MCP-mount probe (mirror of the Cline F1/G3-Step2 mount probe).
 * Does OpenCode's ACP surface mount MCP servers from config the hub writes?
 * This is the load-bearing assumption behind "the hub owns agent MCP
 * config" — skills-mcp (F1) and workflow-fs-exec-mcp (G3) are only enforceable
 * single-delivery-path / single-mutation-path if the agent actually mounts
 * them from a config surface the hub controls. OpenCode has two such
 * surfaces: the project `opencode.json` in the workspace (hub-owned
 * workspace) and the global config resolved through `XDG_CONFIG_HOME`
 * (hub-owned launch env; the config file is
 * `$XDG_CONFIG_HOME/opencode/opencode.json`). The two tests attribute the
 * finding to exactly one surface each — a positive on either unblocks the
 * F1/G3 wiring decision.
 *
 * Gated: run deliberately with WORKFLOW_ACP_OPENCODE_MCP_MOUNT=1 (opencode
 * on PATH with working ambient auth; skills-mcp must be built). The launch
 * passes `--pure` so the stock surface is measured without the operator's
 * global plugins.
 *
 * Interpretation: each test always records evidence — the recorded
 * finalMessage is what distinguishes the outcomes: a verbatim list_skills
 * output means the agent mounted the config from that surface (positive);
 * a NO_MCP_TOOLS reply means that surface is ignored — a negative finding
 * that keeps the hub-owned MCP config assumption unwired for that surface,
 * not a probe failure.
 */

const runProbe = process.env.WORKFLOW_ACP_OPENCODE_MCP_MOUNT === "1";

const SERVER_SCRIPT = path.resolve(import.meta.dirname, "..", "mcp-toolbox", "apps", "skills-mcp", "dist", "server.js");

async function probeMount(label: string, options: { readonly projectConfig: boolean; readonly configDirConfig: boolean }) {
  const scratchHome = await mkdtemp(path.join(tmpdir(), "wf-opencode-mount-home-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "wf-opencode-mount-ws-"));
  try {
    const mcpBlock = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "skills-mcp": {
          type: "local",
          command: [process.execPath, SERVER_SCRIPT],
          environment: { SKILLS_MCP_DIR: path.join(workspace, "skills") },
        },
      },
    };
    if (options.projectConfig) {
      await writeFile(path.join(workspace, "opencode.json"), JSON.stringify(mcpBlock), "utf8");
    }
    if (options.configDirConfig) {
      await mkdir(path.join(scratchHome, ".config", "opencode"), { recursive: true });
      await writeFile(path.join(scratchHome, ".config", "opencode", "opencode.json"), JSON.stringify(mcpBlock), "utf8");
    }
    await mkdir(path.join(workspace, "skills", "probe-skill"), { recursive: true });
    await writeFile(
      path.join(workspace, "skills", "probe-skill", "SKILL.md"),
      "---\nname: probe-skill\ndescription: A mount probe fixture skill.\n---\n\n# Probe Skill\n\nMounted skills are visible.\n",
      "utf8",
    );

    const child = spawn("opencode", ["acp", "--pure", "--cwd", workspace], {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(options.configDirConfig ? { XDG_CONFIG_HOME: path.join(scratchHome, ".config") } : {}),
      },
    });
    const toolCalls: string[] = [];
    const updates: AcpSessionUpdate[] = [];
    const client = new AcpSubprocessClient({
      child,
      resolvePermission: (request) => {
        toolCalls.push(String(request.toolCall?.title ?? request.toolCall?.kind ?? "unknown"));
        return { kind: "allow" };
      },
    });
    client.onSessionUpdate((update) => updates.push(update));

    try {
      const initialized = await client.initialize();
      const session = await client.newSession({ cwd: workspace });
      const result = (await Promise.race([
        client.prompt({
          sessionId: session.sessionId,
          prompt: [{
            type: "text",
            text: "Call the MCP tool list_skills and report its exact output verbatim. If no such tool exists, reply exactly: NO_MCP_TOOLS",
          }],
        }),
        new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 240_000)),
      ])) as { stopReason?: string };

      const finalMessage = updates.flatMap((update) =>
        update.update.sessionUpdate === "agent_message_chunk"
          ? [(update.update.content as { text?: string }).text ?? ""]
          : [],
      ).join("");
      const evidence = {
        surface: label,
        agent: initialized.agentInfo,
        stopReason: result.stopReason,
        gateableToolTitles: toolCalls,
        updateKinds: [...new Set(updates.map((update) => update.update.sessionUpdate))],
        finalMessage: finalMessage.slice(0, 500),
      };
      console.log(JSON.stringify(evidence, null, 2));
      return evidence;
    } finally {
      await client.close();
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  } finally {
    await rm(scratchHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

test(
  "OpenCode ACP MCP-mount probe: project opencode.json is honored",
  { skip: !runProbe, timeout: 300_000 },
  async () => {
    if (!existsSync(SERVER_SCRIPT)) {
      throw new Error(`skills-mcp is not built; run: pnpm --dir mcp-toolbox/apps/skills-mcp run build (expected ${SERVER_SCRIPT})`);
    }
    const evidence = await probeMount("project-opencode.json", { projectConfig: true, configDirConfig: false });
    assert.equal(evidence.stopReason, "end_turn", "the turn must complete (not time out) for mount evidence to count");
    assert.ok(evidence.finalMessage.length > 0, "the turn must record a reply that distinguishes mounted from NO_MCP_TOOLS");
  },
);

test(
  "OpenCode ACP MCP-mount probe: XDG_CONFIG_HOME global config is honored",
  { skip: !runProbe, timeout: 300_000 },
  async () => {
    if (!existsSync(SERVER_SCRIPT)) {
      throw new Error(`skills-mcp is not built; run: pnpm --dir mcp-toolbox/apps/skills-mcp run build (expected ${SERVER_SCRIPT})`);
    }
    const evidence = await probeMount("xdg-config-home-opencode.json", { projectConfig: false, configDirConfig: true });
    assert.equal(evidence.stopReason, "end_turn", "the turn must complete (not time out) for mount evidence to count");
    assert.ok(evidence.finalMessage.length > 0, "the turn must record a reply that distinguishes mounted from NO_MCP_TOOLS");
  },
);
