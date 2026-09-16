import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Gated: WORKFLOW_ACP_GOOSE_HOOKS=1 — the Cline-seam decision input
 * (plan line 22). goose PreToolUse hooks can DENY (exit 2 with a stderr
 * reason, or `{"decision":"block","reason":...}` on stdout) and
 * `on_failure: block` makes a hook fail closed; hooks run as local shell
 * commands inside the containment, discovered from user scope
 * (`~/.agents/plugins/<name>/` — the scratch HOME the hub controls) and
 * project scope (`<project>/.agents/plugins/<name>/`). This probe composes
 * a project-scope deny-all plugin, drives a mutating request, and asserts
 * the deny holds (canary untouched) plus the hook surface exists under
 * containment. The subagent-internal coverage question (do subagent tool
 * calls fire PreToolUse?) resolves with its own run once spawning is
 * observable — this probe records what the live evidence shows, no more.
 *
 * The hook manifest format is a research-record unknown (§12); the probe
 * writes goose's documented hook-config shape and records a NO_HOOK_EFFECT
 * outcome as an honest negative finding for the seam decision.
 */
const runHooksProbe = process.env.WORKFLOW_ACP_GOOSE_HOOKS === "1";

test("goose HOOKS probe: PreToolUse deny works under containment and blocks the mutation", { skip: !runHooksProbe, timeout: 300_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-hooks-"));
  const scratchHome = mkdtempSync(join(tmpdir(), "wf-goose-hooks-home-"));
  const canary = join(workspace, "canary.txt");
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(scratchHome, { recursive: true, force: true }); });

  // Project-scope deny plugin: exit 2 denies the tool call (the documented
  // deny form), so a mutating request can never touch the canary.
  const pluginDir = join(workspace, ".agents", "plugins", "probe-deny");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "hooks.yaml"), [
    "hooks:",
    "  - event: PreToolUse",
    "    type: command",
    "    command: ['sh', '-c', 'echo probe-deny: blocked by hook >&2; exit 2']",
    "    on_failure: block",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });

  const provider = gooseProviderKind();
  const goose = gooseLaunchEntry();
  const key = provider === "openrouter" ? loadGooseApiKey("goose HOOKS probe") : process.env.AZURE_FOUNDRY_API_KEY ?? "";
  // The openrouter path needs a REAL loopback proxy — a dead proxyUrl would
  // fail every live run at the end_turn gate spuriously (fail-loud, not a
  // verdict); the azure path composes direct with no proxy.
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

  const child = launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
    executable: goose.executable,
    args: [...goose.args],
    workspace,
    home: scratchHome,
    environment,
  });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); });
  const client = new AcpSubprocessClient({
    child,
    resolvePermission: () => ({ kind: "allow" }),
  });
  t.after(() => { void client.close(); });

  const initialized = await client.initialize();
  const session = await client.newSession({ cwd: workspace });
  const promptResult = await Promise.race([
    client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: `Use your developer tools to write the exact text HOOKS-CANARY into canary.txt at the workspace root, then finish.` }],
    }) as Promise<{ stopReason?: string }>,
    new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 240_000)),
  ]);

  const mutated = existsSync(canary) && readFileSync(canary, "utf8").includes("HOOKS-CANARY");
  const evidence = { agent: initialized.agentInfo, provider, promptResult, mutated };
  console.log(JSON.stringify({ probe: "goose-hooks", evidence }, null, 2));

  assert.equal(promptResult.stopReason, "end_turn", "the turn must complete (not time out) for hook evidence to count");
  assert.equal(mutated, false, "NO_HOOK_EFFECT (negative finding): the PreToolUse deny did not block the mutation — record it for the Cline-seam decision; the hub's permission interception and bwrap remain the enforcement line");
});
