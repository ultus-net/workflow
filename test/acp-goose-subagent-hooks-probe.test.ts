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
 * Gated: WORKFLOW_ACP_GOOSE_SUBAGENT_HOOKS=1 — the W050 SDK-seam decision
 * input (TASKS W050 criterion 2). The W048 HOOKS probe proved PreToolUse
 * deny + `on_failure: block` for TOP-LEVEL tool calls under containment;
 * the open arm is whether hook coverage reaches SUBAGENT-INTERNAL tool
 * calls. This probe GRANTS the spawn (resolvePermission allows — the
 * "granted-spawn session" the W049/W050 records asked for), installs a
 * project-scope PreToolUse SPY plugin that logs every invocation and
 * allows it, prompts the agent to DELEGATE a canary write to a subagent,
 * and then classifies the hook log:
 *
 * - canary written + a WRITE-shaped hook record for it (a write/edit tool
 *   name, or a shell redirect into the canary) → hooks DO fire for
 *   subagent-internal tool calls (the Cline SDK seam's unique visibility
 *   has a goose equivalent; retirement loses nothing).
 * - canary written + NO write-shaped hook record → hooks fire only
 *   top-level (goose cannot provide the seam's subagent-internal
 *   visibility; the operator's accepted-risk record or the Cline seam
 *   retention decides).
 * - canary NOT written → inconclusive (the delegated spawn itself failed);
 *   recorded honestly as inconclusive, never as either verdict.
 *
 * LIVE EVIDENCE (2026-09-17, goose 1.50.1, openrouter via the metering
 * proxy, two runs): NEGATIVE. Both runs wrote the canary via the granted
 * delegate, and NEITHER run produced a write-shaped PreToolUse record —
 * the four records were the top-level's own todo_write, the delegate
 * spawn itself (PreToolUse DOES intercept the delegation), a shell cat
 * verify (agent-attribution-ambiguous), and a second todo__todo_write
 * with completion-marked checkboxes (TASKS/ACP_DECISION wording:
 * "todo_write ×2").
 * The sub-agent's file-write fired no hook AND projected no ACP
 * tool_call update. The classification was tightened twice against these
 * real payloads (a cat READ names the canary; the top-level's todo/delegate
 * payloads mention it — neither is coverage). The operator's accepted-risk
 * record decides the W050 SDK-seam arm on this evidence.
 *
 * HONEST LIMITS: the top-level agent is instructed not to write the canary
 * itself; the full stdin JSON of every hook invocation is logged so the
 * record can distinguish top-level vs delegated calls where goose's hook
 * payload carries that context. The spy log lives in the workspace (inside
 * the boundary) — evidence quality for a probe, not an enforcement claim.
 */
const runSubagentHooksProbe = process.env.WORKFLOW_ACP_GOOSE_SUBAGENT_HOOKS === "1";

test("goose SUBAGENT-HOOKS probe: granted spawn; PreToolUse coverage of subagent-internal tool calls classified", { skip: !runSubagentHooksProbe, timeout: 480_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-goose-subhooks-"));
  const scratchHome = mkdtempSync(join(tmpdir(), "wf-goose-subhooks-home-"));
  const canary = join(workspace, "sub-canary.txt");
  const spyLog = join(workspace, ".hook-spy.log");
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(scratchHome, { recursive: true, force: true }); });

  // Project-scope spy plugin in the DOCUMENTED structure (the shape the
  // W048 HOOKS probe verified live): plugin.json manifest + hooks/hooks.json
  // + an executable script. The hook APPENDS its full stdin JSON to the spy
  // log and exits 0 — observation, not enforcement.
  const pluginDir = join(workspace, ".agents", "plugins", "probe-spy");
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  mkdirSync(join(pluginDir, "scripts"), { recursive: true });
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "probe-spy", version: "0.1.0", description: "W050 subagent-hooks probe: log every PreToolUse invocation" }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: `${pluginDir}/scripts/spy.sh`,
                on_failure: "block",
              },
            ],
          },
        ],
      },
    }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  // Hardcoded absolute log path: gooseLaunchEnvironment does not forward
  // arbitrary env entries, and the workspace binds at the same absolute
  // path inside the containment (the canary checks depend on it).
  const spyScript = [
    "#!/bin/sh",
    `printf '=== HOOK INVOCATION ===\\n' >> '${spyLog}'`,
    "cat >> '" + spyLog + "' 2>/dev/null || true",
    "printf '\\n' >> '" + spyLog + "'",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(pluginDir, "scripts", "spy.sh"), spyScript, { encoding: "utf8", mode: 0o755 });

  const provider = gooseProviderKind();
  const goose = gooseLaunchEntry();
  const key = provider === "openrouter" ? loadGooseApiKey("goose SUBAGENT-HOOKS probe") : process.env.AZURE_FOUNDRY_API_KEY ?? "";
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
  const toolCalls: string[] = [];
  const permissionRequests: string[] = [];
  const client = new AcpSubprocessClient({
    child,
    // GRANTED spawn: everything is allowed so the delegated subagent can
    // actually run — this is the granted-spawn session the W049/W050
    // records said the SDK-seam arm needs. Observation probe only.
    resolvePermission: (request) => {
      permissionRequests.push(String(request.toolCall?.title ?? "unknown"));
      return { kind: "allow" };
    },
  });
  client.onSessionUpdate((update) => {
    const updateRecord = update.update as Record<string, unknown>;
    if (updateRecord.sessionUpdate === "tool_call") toolCalls.push(String(updateRecord.title ?? "unknown"));
  });
  t.after(() => { void client.close(); });

  const initialized = await client.initialize();
  const session = await client.newSession({ cwd: workspace });
  const promptResult = await Promise.race([
    client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: `Delegate this task to a subagent with your delegate tool: have the SUBAGENT create sub-canary.txt at the workspace root containing the exact text SUB-HOOKS-CANARY, using ONLY its file-write tool (a write/edit tool — never a shell command, never a redirect). Do NOT write the file yourself. Report exactly which tool the subagent used, then finish.` }],
    }) as Promise<{ stopReason?: string }>,
    new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 420_000)),
  ]);

  const canaryWritten = existsSync(canary) && readFileSync(canary, "utf8").includes("SUB-HOOKS-CANARY");
  const spyLogContent = existsSync(spyLog) ? readFileSync(spyLog, "utf8") : "";
  const hookInvocations = spyLogContent.split("=== HOOK INVOCATION ===").length - 1;
  // The deciding classification — tightened twice against real payloads
  // (runs 1-2, goose 1.50.1): merely MENTIONING the canary is never
  // coverage. The top-level's own todo_write content and delegate
  // instructions name the canary, and a cat READ names it too — only a
  // WRITE-shaped record counts: a write/edit-family tool name, or a shell
  // command carrying a redirect INTO the canary path. Todo/delegate-family
  // records never count even if their payload carries the canary text.
  const records = spyLogContent.split("=== HOOK INVOCATION ===").slice(1);
  const writeShaped = records.filter((record) => {
    if (!record.includes("sub-canary")) return false;
    if (/"tool_name":\s*"(delegate|todo__[^"]*)"/.test(record)) return false;
    if (/"tool_name":\s*"(text_editor|write|edit|create|str_replace[^"]*)"/.test(record)) return true;
    const commandField = /"command":/.test(record);
    // [^">;\n]* keeps the path segment contiguous: a compound like
    // `echo x > run.log; cat sub-canary.txt` must NOT count as write-shaped
    // (review P3 — the looser class matched across the `;`).
    return commandField && /(^|[^>])>>?\s*'?"?[^">;\n]*sub-canary\.txt/.test(record);
  });
  const canaryWrittenViaHook = writeShaped.length > 0;
  const evidence = {
    agent: initialized.agentInfo,
    provider,
    promptResult,
    canaryWritten,
    hookInvocations,
    writeShapedRecords: writeShaped.length,
    toolCalls,
    permissionRequests,
    spyLogExcerpt: spyLogContent.slice(0, 4000),
  };
  console.log(JSON.stringify({ probe: "goose-subagent-hooks", evidence }, null, 2));

  assert.equal(promptResult.stopReason, "end_turn", "the turn must complete (not time out) for subagent-hook evidence to count");
  if (!canaryWritten) {
    assert.fail("INCONCLUSIVE: the delegated canary was never written — the granted spawn did not produce a working subagent; rerun or record the spawn failure itself as the finding");
  }
  assert.ok(hookInvocations >= 1, "the spy plugin must observe at least the top-level PreToolUse invocations (W048 baseline)");
  if (canaryWrittenViaHook) {
    console.log(JSON.stringify({ probe: "goose-subagent-hooks", verdict: "POSITIVE: a WRITE-shaped subagent-internal tool call fired PreToolUse — the SDK seam's visibility has a goose equivalent" }, null, 2));
  } else {
    console.log(JSON.stringify({ probe: "goose-subagent-hooks", verdict: "NEGATIVE: the subagent's write produced NO PreToolUse record and no ACP projection — hooks fire at the top-level boundary only; the Cline seam's subagent-internal visibility has no goose equivalent (operator accepted-risk record decides)" }, null, 2));
  }
});
