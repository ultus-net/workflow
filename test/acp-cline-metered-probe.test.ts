import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { AcpSubprocessClient, type AcpPermissionDecision } from "../src/adapters/acp-subprocess.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { createModelUsageProxy, METERED_PLACEHOLDER_KEY, meteredProviderSettings } from "../src/integrations/model-usage-proxy.js";
import { clineEntrypoint, loadClineApiKey } from "./cline-probe-helpers.js";

// G1 token/cost metering proof: the agent's environment contains only a
// placeholder credential while the hub-held proxy injects the real OpenRouter
// key upstream and records usage per session. Cline resolves the provider
// baseUrl from the metered providers.json (via CLINE_PROVIDER_SETTINGS_PATH),
// so every model call crosses the proxy even though the contained env has no
// real credential.
const runMeteredProbe = process.env.WORKFLOW_ACP_CLINE_METERED === "1";

test(
  "Cline ACP metered proxy proves key-free agent env, working turns, and per-session usage metrics",
  { skip: !runMeteredProbe, timeout: 240_000 },
  async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "workflow-acp-metered-ws-"));
    const scratchHome = await mkdtemp(path.join(tmpdir(), "workflow-acp-metered-home-"));
    const target = path.join(workspace, "metered-target.txt");
    await writeFile(target, "before\n", "utf8");

    const clineApiKey = await loadClineApiKey("Cline metered probe");
    const proxy = await createModelUsageProxy({ upstream: "https://openrouter.ai", apiKey: clineApiKey });
    const settingsPath = path.join(scratchHome, "providers.json");
    await writeFile(settingsPath, JSON.stringify(meteredProviderSettings(proxy.url)), "utf8");

    const child = launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
      executable: process.execPath,
      script: clineEntrypoint(),
      args: ["--acp", "--provider", "openrouter", "--auto-approve", "false", "--cwd", workspace],
      workspace,
      home: scratchHome,
      environment: {
        // Placeholder only: satisfies Cline's isSessionReady while the real
        // key stays exclusively in the hub-side proxy.
        CLINE_API_KEY: METERED_PLACEHOLDER_KEY,
        CLINE_PROVIDER: process.env.CLINE_PROVIDER ?? "openrouter",
        CLINE_PROVIDER_SETTINGS_PATH: settingsPath,
      },
    });
    const client = new AcpSubprocessClient({
      child,
      resolvePermission: (): AcpPermissionDecision => ({ kind: "allow" }),
    });

    let content: string;
    try {
      const initialized = await client.initialize();
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
      await client.close();
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      await proxy.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(scratchHome, { recursive: true, force: true });
    }

    const metrics = proxy.metrics();
    assert.ok(content.includes("metered"), "the allowed workspace command must execute through the metered path");
    assert.ok(metrics.requests > 0, "proxy must have observed model traffic");
    assert.ok(metrics.usageEvents > 0, "proxy must have recorded usage accounting");
    assert.ok(metrics.totalTokens > 0, "proxy must have counted tokens for the session");
  },
);
