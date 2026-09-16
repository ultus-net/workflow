import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";
import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { gooseConfigYaml, gooseLaunchEnvironment, gooseProviderKind } from "../src/integrations/goose-agent-config.js";
import { loadGooseApiKey, gooseLaunchEntry } from "./goose-probe-helpers.js";

/**
 * Gated: WORKFLOW_ACP_GOOSE_RESUME=1 — `session/load` across a FULL
 * contained restart (G4): transcript replay and model-context restore.
 * goose's state lives under `GOOSE_PATH_ROOT` (`state/` beneath it per the
 * research), so both phases share the SAME scratch home and config root —
 * a fresh mkdtemp per phase would starve the persistence the probe measures.
 */
const runResumeProbe = process.env.WORKFLOW_ACP_GOOSE_RESUME === "1";

test("goose RESUME probe: session/load restores transcript and model context across a contained restart", { skip: !runResumeProbe, timeout: 420_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-resume-"));
  const scratchHome = mkdtempSync(join(tmpdir(), "wf-goose-resume-home-"));
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(scratchHome, { recursive: true, force: true }); });

  const provider = gooseProviderKind();
  const goose = gooseLaunchEntry();
  const key = provider === "openrouter" ? loadGooseApiKey("goose RESUME probe") : process.env.AZURE_FOUNDRY_API_KEY ?? "";
  const configRoot = join(scratchHome, "goose-root");
  mkdirSync(join(configRoot, "config"), { recursive: true, mode: 0o700 });
  const configYaml = gooseConfigYaml({});
  if (configYaml !== undefined) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(configRoot, "config", "config.yaml"), configYaml, { encoding: "utf8", mode: 0o600 });
  }
  const environment = gooseLaunchEnvironment({
    provider,
    configRoot,
    proxyUrl: "http://127.0.0.1:1",
    env: { ...process.env, CLINE_API_KEY: key, AZURE_FOUNDRY_API_KEY: process.env.AZURE_FOUNDRY_API_KEY ?? "" },
  });

  const launch = () => launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
    executable: goose.executable,
    args: [...goose.args],
    workspace,
    home: scratchHome,
    environment,
  });

  const KEYWORD = "GOOSE-RESUME-KEYWORD-7F31";

  // Phase 1: a keyword turn under the first contained agent.
  const child1 = launch();
  const client1 = new AcpSubprocessClient({ child: child1, resolvePermission: () => ({ kind: "allow" }) });
  const initialized1 = await client1.initialize();
  const session1 = await client1.newSession({ cwd: workspace });
  const phase1 = await Promise.race([
    client1.prompt({
      sessionId: session1.sessionId,
      prompt: [{ type: "text", text: `Remember the code phrase ${KEYWORD} for later. Reply with the phrase once, then finish.` }],
    }) as Promise<{ stopReason?: string }>,
    new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 180_000)),
  ]);
  assert.equal(phase1.stopReason, "end_turn", "phase 1 must complete for resume evidence to exist");
  const sessionId = session1.sessionId;
  await client1.close();
  if (child1.exitCode === null && !child1.killed) child1.kill("SIGKILL");

  // Phase 2: a FULL contained restart, the same scratch home, session/load.
  const child2 = launch();
  const client2 = new AcpSubprocessClient({ child: child2, resolvePermission: () => ({ kind: "allow" }) });
  const updates: unknown[] = [];
  client2.onSessionUpdate((update) => updates.push(update));
  const initialized2 = await client2.initialize();
  await client2.loadSession({ sessionId, cwd: workspace });
  const phase2 = await Promise.race([
    client2.prompt({
      sessionId,
      prompt: [{ type: "text", text: `What code phrase did I ask you to remember? Reply with the exact phrase, then finish.` }],
    }) as Promise<{ stopReason?: string }>,
    new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 180_000)),
  ]);

  const chunks: string[] = [];
  for (const update of updates) {
    const record = (update as { update: Record<string, unknown> }).update;
    if (record.sessionUpdate === "agent_message_chunk") {
      const content = record.content as { text?: string } | undefined;
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  const answer = chunks.join("");
  const replayed = updates.some((update) => {
    const record = (update as { update: Record<string, unknown> }).update;
    return record.sessionUpdate === "user_message_chunk" || record.sessionUpdate === "agent_message_chunk";
  });
  const evidence = { phase1Agent: initialized1.agentInfo, phase2Agent: initialized2.agentInfo, provider, phase2, replayed, answer };
  console.log(JSON.stringify({ probe: "goose-resume", evidence }, null, 2));

  assert.equal(phase2.stopReason, "end_turn", "the continuation turn must complete (not time out)");
  assert.ok(replayed, "session/load must replay the prior transcript");
  assert.ok(answer.includes(KEYWORD), `model context must be restored (the exact keyword ${KEYWORD} recalled)`);
});
