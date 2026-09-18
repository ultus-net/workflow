import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { AcpSubprocessClient, type AcpPermissionDecision, type AcpSessionUpdate } from "../src/adapters/acp-subprocess.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { clineLaunchEntry, loadClineApiKey } from "./cline-probe-helpers.js";

// G4 resume fidelity: does Cline's advertised loadSession actually replay a
// persisted session faithfully after the agent process restarts? Phase 1
// creates a session with a unique keyword turn inside a contained, persistent
// scratch HOME; phase 2 relaunches a fresh contained agent against the same
// HOME and loads the session, asserting the replay carries the original
// prompt (in user chunks) and the keyword answer (in agent chunks). The
// continuation recall assertion below is the G4 gap contract and it
// currently FAILS deterministically (G4 reopened 2026-09-16,
// docs/ACP_SURFACE.md): loadSession replays the visible transcript but does
// NOT restore the model's context, so a resumed continuation cannot recall
// the keyword. Keep the assertion as the desired-behavior contract — a
// gated run documents the failure until Cline's session/load restores model
// context; do not weaken it into a pass.
const runResumeProbe = process.env.WORKFLOW_ACP_CLINE_RESUME === "1";

test(
  "Cline ACP resume probe replays a persisted session faithfully after an agent restart",
  { skip: !runResumeProbe, timeout: 300_000 },
  async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "workflow-acp-resume-ws-"));
    const scratchHome = await mkdtemp(path.join(tmpdir(), "workflow-acp-resume-home-"));
    const keyword = `resume-${randomUUID().slice(0, 8)}`;
    const clineApiKey = await loadClineApiKey("Cline resume probe");
    const cline = clineLaunchEntry();

    const launch = () => launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
      executable: cline.executable,
      ...(cline.script !== undefined ? { script: cline.script } : {}),
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
    const continuationUpdates: AcpSessionUpdate[] = [];
    let loading = true;
    const phaseTwoChild = launch();
    const phaseTwo = new AcpSubprocessClient({
      child: phaseTwoChild,
      resolvePermission: (): AcpPermissionDecision => ({ kind: "allow" }),
    });
    let continuation: unknown;
    try {
      await phaseTwo.initialize();
      phaseTwo.onSessionUpdate((update) => (loading ? replayed : continuationUpdates).push(update));
      await phaseTwo.loadSession({ sessionId, cwd: workspace });
      loading = false;
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

    // Scope assertions to specific chunk kinds so the keyword embedded in the
    // user prompt cannot satisfy the agent-answer check; the recall assertion
    // is the G4 contract (see the header comment — it currently fails
    // deterministically because loadSession does not restore model context).
    const chunkText = (updates: AcpSessionUpdate[], kind: string) =>
      updates.flatMap((update) =>
        update.update.sessionUpdate === kind ? [(update.update.content as { text?: string }).text ?? ""] : [],
      ).join("");
    const userPromptReplayed = chunkText(replayed, "user_message_chunk").includes("Reply with exactly this token");
    const keywordReplayed = chunkText(replayed, "agent_message_chunk").includes(keyword);
    const keywordRecalled = chunkText(continuationUpdates, "agent_message_chunk").includes(keyword);
    const replayKinds = replayed.map((update) => update.update.sessionUpdate);
    console.log(JSON.stringify({
      sessionId,
      replayKinds,
      userPromptReplayed,
      keywordReplayed,
      keywordRecalled,
      continuation,
    }, null, 2));

    assert.ok(replayKinds.includes("user_message_chunk"), "replay must include the user turn");
    assert.ok(replayKinds.includes("agent_message_chunk"), "replay must include the agent turn");
    assert.ok(userPromptReplayed, "user chunks must carry the original prompt");
    assert.ok(keywordReplayed, "agent replay chunks must carry the keyword answer");
    assert.ok(keywordRecalled, "continuation agent chunks must recall the keyword (restored context)");
    assert.equal((continuation as { stopReason?: string }).stopReason, "end_turn", "continuation turn must complete after reload");
  },
);
