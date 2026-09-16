import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { AcpSubprocessClient, type AcpPermissionDecision } from "../src/adapters/acp-subprocess.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import {
  globalOpencodeBinary,
  meteredOpencodeConfig,
  resolveOpencodeLaunch,
} from "../src/integrations/opencode-agent-config.js";
import { loadClineApiKey } from "./cline-probe-helpers.js";

// G1 token/cost metering proof for the lead agent: the contained OpenCode
// environment carries only a placeholder credential while the hub-held proxy
// injects the real upstream key and records usage per session. The agent
// resolves its provider from the hub-written XDG_CONFIG_HOME config (the
// surface the MCP-mount probe proved honored), so every model call crosses
// the proxy even though the contained env has no real credential. Launched
// with --pure so the operator's global plugins stay out of the measurement.
const runMeteredProbe = process.env.WORKFLOW_ACP_OPENCODE_METERED === "1";

test(
  "OpenCode ACP metered proxy proves key-free agent env, working turns, and per-session usage metrics",
  { skip: !runMeteredProbe, timeout: 240_000 },
  async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "workflow-acp-oc-metered-ws-"));
    const scratchHome = await mkdtemp(path.join(tmpdir(), "workflow-acp-oc-metered-home-"));
    const configDir = path.join(scratchHome, "config");
    const target = path.join(workspace, "metered-target.txt");
    await writeFile(target, "before\n", "utf8");
    await mkdir(path.join(configDir, "opencode"), { recursive: true });

    const upstreamKey = await loadClineApiKey("OpenCode metered probe");
    const proxy = await createModelUsageProxy({ upstream: process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai", apiKey: upstreamKey });
    await writeFile(
      path.join(configDir, "opencode", "opencode.json"),
      JSON.stringify(meteredOpencodeConfig({ proxyUrl: proxy.url, model: process.env.WORKFLOW_OPENCODE_MODEL })),
      "utf8",
    );

    const opencode = resolveOpencodeLaunch({
      envBinOverride: process.env.WORKFLOW_OPENCODE_BIN,
      opencodeOnPath: globalOpencodeBinary(),
    });
    const child = launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
      executable: opencode.executable,
      args: ["acp", "--pure"],
      workspace,
      home: scratchHome,
      environment: {
        // The placeholder credential rides the 0600 config file written
        // above; the real upstream key stays exclusively in the hub-side
        // proxy and never enters the boundary.
        XDG_CONFIG_HOME: configDir,
      },
    });
    // A startup crash inside the boundary is otherwise silent: capture the
    // agent's stderr so a failed gated run explains itself.
    const stderrChunks: string[] = [];
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderrChunks.push(chunk));
    const client = new AcpSubprocessClient({
      child,
      resolvePermission: (): AcpPermissionDecision => ({ kind: "allow" }),
    });

    let content: string;
    let promptResult: { stopReason?: string };
    let initialized: Awaited<ReturnType<AcpSubprocessClient["initialize"]>>;
    try {
      initialized = await client.initialize();
      const session = await client.newSession({ cwd: workspace });
      const result = await Promise.race([
        client.prompt({
          sessionId: session.sessionId,
          prompt: [{
            type: "text",
            text: "Run exactly one shell command to append the text `metered` to metered-target.txt. Do not use file editing tools directly.",
          }],
        }),
        new Promise((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 90_000)),
      ]);
      promptResult = result as { stopReason?: string };
      content = await readFile(target, "utf8");
      console.log(JSON.stringify({
        agent: initialized.agentInfo,
        metering: "hub-proxy",
        agentCredential: "placeholder-only",
        prompt: result,
        metrics: proxy.metrics(),
        workspaceContent: content,
      }, null, 2));
    } finally {
      const agentStderr = stderrChunks.join("");
      if (agentStderr.length > 0) console.log("agent stderr:", agentStderr.slice(0, 2000));
      await client.close();
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      await proxy.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(scratchHome, { recursive: true, force: true });
    }

    const metrics = proxy.metrics();
    assert.equal(initialized.agentInfo?.name, "OpenCode");
    assert.equal(promptResult.stopReason, "end_turn", "the turn must complete (not time out) for metering evidence to count");
    assert.ok(content.includes("metered"), "the allowed workspace command must execute through the metered path");
    assert.ok(metrics.requests > 0, "proxy must have observed model traffic");
    assert.ok(metrics.usageEvents > 0, "proxy must have recorded usage accounting");
    assert.ok(metrics.totalTokens > 0, "proxy must have counted tokens for the session");
  },
);
