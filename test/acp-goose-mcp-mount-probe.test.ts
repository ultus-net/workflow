import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";
import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { gooseConfigYaml, gooseLaunchEnvironment, gooseProviderKind } from "../src/integrations/goose-agent-config.js";
import { createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import { loadGooseApiKey, gooseLaunchEntry } from "./goose-probe-helpers.js";

/**
 * Gated: WORKFLOW_ACP_GOOSE_MCP_MOUNT=1 — the MOUNT probe. Whether
 * `goose acp` honors hub-written config under `GOOSE_PATH_ROOT` is exactly
 * the load-bearing unknown (`docs/GOOSE_RESEARCH.md` §12 unknown 1): this
 * probe composes the per-runtime config.yaml with the skills-mcp stdio
 * extension and asks the agent to list skills. A `NO_MCP_TOOLS` reply is a
 * NEGATIVE FINDING recorded honestly (the Cline MCP-mount precedent), not
 * a probe failure; a verbatim skills reply is the positive finding that
 * unblocks the F1/G3 single-delivery path on goose.
 */
const runMountProbe = process.env.WORKFLOW_ACP_GOOSE_MCP_MOUNT === "1";

test("goose MOUNT probe: hub-written GOOSE_PATH_ROOT config mounts the skills-mcp stdio extension", { skip: !runMountProbe, timeout: 300_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-mount-"));
  const scratchHome = mkdtempSync(join(tmpdir(), "wf-goose-home-"));
  const skillsDir = mkdtempSync(join(tmpdir(), "wf-goose-skills-"));
  // The fixture shape skills-mcp discovers (the passing opencode-mount
  // precedent): one directory per skill carrying a frontmatter SKILL.md.
  mkdirSync(join(skillsDir, "probe-skill"), { recursive: true });
  writeFileSync(
    join(skillsDir, "probe-skill", "SKILL.md"),
    "---\nname: probe-skill\ndescription: A mount probe fixture skill.\n---\n\n# Probe Skill\n\nMounted skills are visible.\n",
    { encoding: "utf8" },
  );
  t.after(() => { for (const dir of [workspace, scratchHome, skillsDir]) rmSync(dir, { recursive: true, force: true }); });

  const serverScript = join(process.cwd(), "mcp-toolbox", "apps", "skills-mcp", "dist", "server.js");
  const provider = gooseProviderKind();
  const goose = gooseLaunchEntry();
  const key = provider === "openrouter" ? loadGooseApiKey("goose MOUNT probe") : process.env.AZURE_FOUNDRY_API_KEY ?? "";
  // The openrouter path needs a REAL loopback proxy — a dead proxyUrl would
  // fail every live run at the end_turn gate spuriously (fail-loud, not a
  // verdict); the azure path composes direct with no proxy.
  const proxy = provider === "openrouter"
    ? await createModelUsageProxy({ upstream: process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai", apiKey: key })
    : undefined;
  if (proxy !== undefined) t.after(() => { void proxy.close(); });
  const configRoot = join(scratchHome, "goose-root");
  mkdirSync(join(configRoot, "config"), { recursive: true, mode: 0o700 });
  const configYaml = gooseConfigYaml({ skillsServerScript: serverScript, skillsDir });
  if (configYaml === undefined) {
    throw new Error("goose MOUNT probe requires the built skills-mcp server and a skills dir");
  }
  writeFileSync(join(configRoot, "config", "config.yaml"), configYaml, { encoding: "utf8", mode: 0o600 });

  const environment = gooseLaunchEnvironment({
    provider,
    configRoot,
    proxyUrl: proxy?.url,
    env: { ...process.env, CLINE_API_KEY: key, AZURE_FOUNDRY_API_KEY: process.env.AZURE_FOUNDRY_API_KEY ?? "" },
  });

  const child = launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
    executable: goose.executable,
    args: [...goose.args],
    workspace,
    home: scratchHome,
    // Runtime-parity: goose spawns the skills server INSIDE the boundary —
    // without the readablePaths the runtime composes, the extension spawn
    // fails inside bwrap and goose drops the extension (a probe-composition
    // bug, not a goose finding — fixed after the first NO_MCP_TOOLS runs).
    ...(serverScript === undefined
      ? {}
      : {
          readablePaths: [
            dirname(serverScript),
            resolve(dirname(serverScript), "..", "node_modules"),
            resolve(dirname(serverScript), "..", "..", "..", "node_modules"),
            skillsDir,
            realpathSync(skillsDir),
          ],
        }),
    environment,
  });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); });
  const updates: unknown[] = [];
  const client = new AcpSubprocessClient({
    child,
    resolvePermission: () => ({ kind: "allow" }),
  });
  client.onSessionUpdate((update) => updates.push(update));
  t.after(() => { void client.close(); });

  const initialized = await client.initialize();
  const session = await client.newSession({ cwd: workspace });
  const promptResult = await Promise.race([
    client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: `Call the list_skills tool and reply with the exact text it returns. If you have no such tool, reply exactly: NO_MCP_TOOLS` }],
    }) as Promise<{ stopReason?: string }>,
    new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 240_000)),
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
  const evidence = { agent: initialized.agentInfo, provider, promptResult, answer, configYaml };
  console.log(JSON.stringify({ probe: "goose-mcp-mount", evidence }, null, 2));

  assert.equal(promptResult.stopReason, "end_turn", "the turn must complete (not time out) for mount evidence to count");
  // Honest-negative rule (the Cline MCP-mount precedent): the NO_MCP_TOOLS
  // marker is a recorded negative finding — this assert DELIBERATELY fails
  // so the run surfaces the verdict, and the operator records it in
  // docs/HOST_ADAPTERS.md rather than treating it as a silent skip.
  assert.ok(!answer.includes("NO_MCP_TOOLS"), "NEGATIVE FINDING: goose did not mount the hub-written GOOSE_PATH_ROOT config (NO_MCP_TOOLS) — record it in docs/HOST_ADAPTERS.md");
  assert.match(answer, /probe-skill|list_skills/i, "the skills-mcp mount must deliver the skills verbatim");
});
