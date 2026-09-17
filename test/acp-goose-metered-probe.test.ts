import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";
import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { gooseConfigYaml, gooseLaunchEnvironment, gooseProviderKind } from "../src/integrations/goose-agent-config.js";
import { createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import { loadGooseApiKey, gooseLaunchEntry } from "./goose-probe-helpers.js";

/**
 * Gated: WORKFLOW_ACP_GOOSE_METERED=1 — G1/G7 evidence on both operator
 * providers (plan line 21). OPENROUTER run: the contained turn completes
 * with only the placeholder credential inside the boundary while the
 * loopback proxy records traffic, and the `usage_update` channel(s) are
 * confirmed (goose emits usage on its custom `_goose/unstable/session/update`
 * notification at minimum — `docs/GOOSE_RESEARCH.md` §4). AZURE_FOUNDRY run
 * (set WORKFLOW_GOOSE_PROVIDER=azure_foundry): no local proxy; the
 * assertion surface is the usage channel plus a completing turn. Run the
 * probe twice, once per provider.
 */
const runMeteredProbe = process.env.WORKFLOW_ACP_GOOSE_METERED === "1";

test("goose METERED probe: placeholder-only credential inside the boundary; proxy records traffic; usage channels confirmed", { skip: !runMeteredProbe, timeout: 300_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-metered-"));
  const scratchHome = mkdtempSync(join(tmpdir(), "wf-goose-metered-home-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(scratchHome, { recursive: true, force: true }); });

  const provider = gooseProviderKind();
  const goose = gooseLaunchEntry();
  const key = provider === "openrouter" ? loadGooseApiKey("goose METERED probe") : process.env.AZURE_FOUNDRY_API_KEY ?? "";
  const proxy = provider === "openrouter"
    ? await createModelUsageProxy({ upstream: process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai", apiKey: key })
    : undefined;
  if (proxy !== undefined) t.after(() => { void proxy.close(); });

  const configRoot = join(scratchHome, "goose-root");
  mkdirSync(join(configRoot, "config"), { recursive: true, mode: 0o700 });
  const configYaml = gooseConfigYaml({});
  if (configYaml !== undefined) {
    writeFileSync(join(configRoot, "config", "config.yaml"), configYaml, { encoding: "utf8", mode: 0o600 });
  }
  const environment = gooseLaunchEnvironment({
    provider,
    configRoot,
    proxyUrl: proxy?.url,
    env: { ...process.env, CLINE_API_KEY: key, AZURE_FOUNDRY_API_KEY: process.env.AZURE_FOUNDRY_API_KEY ?? "" },
  });
  // The boundary credential must be the placeholder, never the real key.
  if (provider === "openrouter") {
    assert.equal(environment.OPENROUTER_API_KEY, "workflow-metered");
  }

  const child = launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
    executable: goose.executable,
    args: [...goose.args],
    workspace,
    home: scratchHome,
    environment,
  });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); });
  const updates: { sessionUpdate: string; method?: string }[] = [];
  const client = new AcpSubprocessClient({ child, resolvePermission: () => ({ kind: "allow" }) });
  client.onSessionUpdate((update) => updates.push({ sessionUpdate: update.update.sessionUpdate, method: "session/update" }));
  t.after(() => { void client.close(); });

  const initialized = await client.initialize();
  const session = await client.newSession({ cwd: workspace });
  const promptResult = await Promise.race([
    client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: `Reply with the single word READY and finish.` }],
    }) as Promise<{ stopReason?: string }>,
    new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 240_000)),
  ]);

  const evidence = {
    agent: initialized.agentInfo,
    provider,
    promptResult,
    ...(proxy === undefined ? {} : { metrics: proxy.metrics() }),
    usageChannels: updates.filter((update) => update.sessionUpdate === "usage_update").length,
  };
  console.log(JSON.stringify({ probe: "goose-metered", evidence }, null, 2));

  assert.equal(promptResult.stopReason, "end_turn", "the turn must complete (not time out) for metering evidence to count");
  if (provider === "openrouter") {
    const metrics = proxy?.metrics();
    assert.ok(metrics !== undefined && metrics.requests > 0, "the loopback proxy must record the agent's model traffic");
    assert.ok(metrics.totalTokens > 0, "the proxy must record token usage");
  }
  // W047's projection makes the usage channels observable: at least one
  // usage_update kind (standard or goose custom) must reach the session
  // record for G7 visibility evidence. A zero here is recorded as a
  // channel-absent finding, not a probe pass.
  assert.ok(evidence.usageChannels > 0, "at least one usage_update must project into the session record (standard or _goose/unstable channel)");
});
