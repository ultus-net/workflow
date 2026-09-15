import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";

/**
 * Plan Task F1/G3-Step2 mount probe: does a stock Cline ACP agent pick up
 * MCP servers from the scratch-home config? This is the load-bearing
 * assumption behind "the hub owns agent MCP config" — skills-mcp (F1) and
 * workflow-fs-exec-mcp (G3) are only enforceable single-delivery-path /
 * single-mutation-path if the agent actually mounts them from the config the
 * hub writes into the scratch home. The vendored patch used
 * ~/.workflow/cline_mcp_settings.json; the STOCK surface is unverified, so
 * this probe writes every known candidate path and reports evidence for
 * which (if any) the agent honored — the input the acp-runtime wiring needs.
 *
 * Gated: WORKFLOW_ACP_CLINE_MCP_MOUNT=1 plus CLINE_API_KEY (and any auth env
 * the other Cline probes use, e.g. WORKFLOW_ACP_CLINE_ENV_AUTH=1).
 *
 * Interpretation: the probe always records evidence. NO skills-shaped tool
 * activity plus a NO_MCP_TOOLS reply means the stock agent ignores every
 * candidate path — a negative finding that keeps the hub-owned MCP config
 * assumption unwired (F1/G3 mounts stay deferred), not a probe failure.
 */

const runProbe = process.env.WORKFLOW_ACP_CLINE_MCP_MOUNT === "1";

if (runProbe && !process.env.CLINE_API_KEY) {
  throw new Error("CLINE_API_KEY is required for the MCP mount probe; do not paste it into chat");
}

const CANDIDATES = [
  path.join(".workflow", "cline_mcp_settings.json"),
  path.join(".config", "workflow", "cline_mcp_settings.json"),
  path.join(".config", "cline", "mcp_settings.json"),
  path.join(".cline", "mcp_settings.json"),
];

test(
  "Cline ACP MCP-mount probe: does the stock agent mount hub-configured MCP servers from the scratch home?",
  { skip: !runProbe, timeout: 300_000 },
  async () => {
    const serverScript = path.resolve(import.meta.dirname, "..", "mcp-toolbox", "apps", "skills-mcp", "dist", "server.js");
    if (!existsSync(serverScript)) {
      throw new Error(`skills-mcp is not built; run: pnpm --dir mcp-toolbox/apps/skills-mcp run build (expected ${serverScript})`);
    }
    const scratchHome = await mkdtemp(path.join(tmpdir(), "wf-mcp-mount-home-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "wf-mcp-mount-ws-"));
    try {
      const mcpConfig = {
        mcpServers: {
          "skills-mcp": {
            command: process.execPath,
            args: [serverScript],
            env: { SKILLS_MCP_DIR: path.join(workspace, "skills") },
          },
        },
      };
      const written: string[] = [];
      for (const candidate of CANDIDATES) {
        const target = path.join(scratchHome, candidate);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify(mcpConfig), "utf8");
        written.push(candidate);
      }
      await mkdir(path.join(workspace, "skills", "probe-skill"), { recursive: true });
      await writeFile(
        path.join(workspace, "skills", "probe-skill", "SKILL.md"),
        "---\nname: probe-skill\ndescription: A mount probe fixture skill.\n---\n\n# Probe Skill\n\nMounted skills are visible.\n",
        "utf8",
      );

      const child = spawn("cline", ["--acp", "--auto-approve", "false", "--cwd", workspace], {
        cwd: workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: scratchHome, XDG_CONFIG_HOME: path.join(scratchHome, ".config") },
      });
      const toolCalls: string[] = [];
      const client = new AcpSubprocessClient({
        child,
        resolvePermission: (request) => {
          toolCalls.push(String(request.toolCall?.title ?? request.toolCall?.kind ?? "unknown"));
          return { kind: "allow" };
        },
      });
      const updates: string[] = [];
      client.onSessionUpdate((update) => updates.push(update.update.sessionUpdate));

      try {
        const initialized = await client.initialize();
        const session = await client.newSession({ cwd: workspace });
        const result = await Promise.race([
          client.prompt({
            sessionId: session.sessionId,
            prompt: [{
              type: "text",
              text: "Call the MCP tool list_skills and report its exact output verbatim. If no such tool exists, reply exactly: NO_MCP_TOOLS",
            }],
          }),
          new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 240_000)),
        ]) as { stopReason?: string };

        const evidence = {
          agent: initialized.agentInfo,
          stopReason: result.stopReason,
          candidatePaths: written,
          gateableToolTitles: toolCalls,
          updateKinds: [...new Set(updates)],
        };
        console.log(JSON.stringify(evidence, null, 2));
        assert.equal(evidence.candidatePaths.length, CANDIDATES.length, "all candidate configs were written");
      } finally {
        await client.close();
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      }
    } finally {
      await rm(scratchHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
