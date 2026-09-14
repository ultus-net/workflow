import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { AcpSubprocessClient, type AcpPermissionDecision, type AcpSessionUpdate } from "../src/adapters/acp-subprocess.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";

// G4 resume fidelity: does Cline's advertised loadSession actually replay a
// persisted session faithfully after the agent process restarts? Phase 1
// creates a session with a unique keyword turn inside a contained, persistent
// scratch HOME; phase 2 relaunches a fresh contained agent against the same
// HOME and loads the session, asserting the replay carries both the user
// prompt and the keyword answer, and that a continuation turn still works.
const runResumeProbe = process.env.WORKFLOW_ACP_CLINE_RESUME === "1";
const keyFile = process.env.CLINE_API_KEY_FILE ?? path.join(homedir(), ".config", "workflow", "cline-api-key");

async function loadClineApiKey(): Promise<string> {
  if (process.env.CLINE_API_KEY) return process.env.CLINE_API_KEY;
  const key = (await readFile(keyFile, "utf8")).trim();
  if (!key) throw new Error("Cline resume probe requires CLINE_API_KEY or CLINE_API_KEY_FILE");
  return key;
}

function clineEntrypoint(): string {
  const bin = execFileSync("/usr/bin/which", ["cline"], { encoding: "utf8" }).trim();
  return realpathSync(bin);
}

test(
  "Cline ACP resume probe replays a persisted session faithfully after an agent restart",
  { skip: !runResumeProbe, timeout: 300_000 },
  async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "workflow-acp-resume-ws-"));
    const scratchHome = await mkdtemp(path.join(tmpdir(), "workflow-acp-resume-home-"));
    const keyword = `resume-${randomUUID().slice(0, 8)}`;
    const clineApiKey = await loadClineApiKey();
    const script = clineEntrypoint();

    const launch = () => launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
      executable: process.execPath,
      script,
      args: ["--acp", "--provider", "openrouter", "--auto-approve", "false", "--cwd", workspace],
      workspace,
      home: scratchHome,
      environment: { CLINE_API_KEY: clineApiKey, CLINE_PROVIDER: process.env.CLINE_PROVIDER ?? "openrouter" },
    });
    const promptWithTimeout = (client: AcpSubprocessClient, sessionId: string, text: string, ms: number) =>
      Promise.race([
        client.prompt({ sessionId, prompt: [{ type: "text", text }] }),
        new Promise((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), ms)),
      ]);

    let sessionId: string;
    const phaseOneChild = launch();
    const phaseOne = new AcpSubprocessClient({
      child: phaseOneChild,
      resolvePermission: (): AcpPermissionDecision => ({ kind: "allow" }),
    });
    try {
      await phaseOne.initialize();
      const session = await phaseOne.newSession({ cwd: workspace });
      sessionId = session.sessionId;
      await promptWithTimeout(phaseOne, sessionId, `Reply with exactly this token and nothing else: ${keyword}`, 75_000);
    } finally {
      await phaseOne.close();
      if (phaseOneChild.exitCode === null && !phaseOneChild.killed) phaseOneChild.kill("SIGKILL");
    }
    assert.ok(sessionId, "phase 1 must produce a session id");

    const replayed: AcpSessionUpdate[] = [];
    const phaseTwoChild = launch();
    const phaseTwo = new AcpSubprocessClient({
      child: phaseTwoChild,
      resolvePermission: (): AcpPermissionDecision => ({ kind: "allow" }),
    });
    let continuation: unknown;
    try {
      await phaseTwo.initialize();
      phaseTwo.onSessionUpdate((update) => replayed.push(update));
      await phaseTwo.loadSession({ sessionId, cwd: workspace });
      continuation = await promptWithTimeout(
        phaseTwo,
        sessionId,
        "What token did I ask you to reply with earlier in this session? Reply with just the token.",
        90_000,
      );
    } finally {
      await phaseTwo.close();
      if (phaseTwoChild.exitCode === null && !phaseTwoChild.killed) phaseTwoChild.kill("SIGKILL");
      await rm(workspace, { recursive: true, force: true });
      await rm(scratchHome, { recursive: true, force: true });
    }

    const replayKinds = replayed.map((update) => update.update.sessionUpdate);
    const replayText = JSON.stringify(replayed);
    const userPromptReplayed = replayText.includes("Reply with exactly this token");
    const keywordReplayed = replayText.includes(keyword);
    console.log(JSON.stringify({
      sessionId,
      replayKinds,
      userPromptReplayed,
      keywordReplayed,
      continuation,
    }, null, 2));

    assert.ok(replayKinds.includes("user_message_chunk"), "replay must include the user turn");
    assert.ok(replayKinds.includes("agent_message_chunk"), "replay must include the agent turn");
    assert.ok(userPromptReplayed, "replay must carry the original user prompt");
    assert.ok(keywordReplayed, "replay must carry the keyword answer");
    assert.deepEqual(continuation, { stopReason: "end_turn" }, "continuation turn must complete after reload");
  },
);
