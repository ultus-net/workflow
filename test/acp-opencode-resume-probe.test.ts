import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient, type AcpPermissionDecision, type AcpSessionUpdate } from "../src/adapters/acp-subprocess.js";

// G4-equivalent resume fidelity for OpenCode: does the advertised loadSession
// actually restore a persisted session faithfully after the agent process
// restarts? Phase 1 creates a session with a unique keyword turn; phase 2
// relaunches a fresh `opencode acp` against the same workspace and loads the
// session, asserting the replay carries the original prompt (in user chunks)
// and the keyword answer (in agent chunks). The continuation recall
// assertion is the desired-behavior contract — whether OpenCode's
// session/load restores the model's context (unlike Cline 3.0.61, where the
// equivalent probe fails deterministically per docs/ACP_SURFACE.md G4) is
// exactly what this probe measures; do not weaken it into a pass. Sessions
// persist through OpenCode's ambient store (keyed by the workspace path), so
// the launch keeps the ambient environment that the other OpenCode probes
// proved working.
const runResumeProbe = process.env.WORKFLOW_ACP_OPENCODE_RESUME === "1";

test(
  "OpenCode ACP resume probe replays and recalls a persisted session after an agent restart",
  { skip: !runResumeProbe, timeout: 300_000 },
  async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "wf-opencode-resume-ws-"));
    const keyword = `resume-${randomUUID().slice(0, 8)}`;

    const launch = () => spawn("opencode", ["acp", "--pure", "--cwd", workspace], {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
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
    }

    // Scope assertions to specific chunk kinds so the keyword embedded in the
    // user prompt cannot satisfy the agent-answer check; chunk text is joined
    // across updates before matching so a reply split across chunk boundaries
    // still satisfies the recall contract.
    const chunkText = (updates: AcpSessionUpdate[], kind: string) =>
      updates.flatMap((update) =>
        update.update.sessionUpdate === kind ? [(update.update.content as { text?: string }).text ?? ""] : [],
      ).join("");
    const userPromptReplayed = chunkText(replayed, "user_message_chunk").includes("Reply with exactly this token");
    const keywordReplayed = chunkText(replayed, "agent_message_chunk").includes(keyword);
    const keywordRecalled = chunkText(continuationUpdates, "agent_message_chunk").includes(keyword);
    const replayKinds = replayed.map((update) => update.update.sessionUpdate);
    const continuationReply = continuationUpdates.flatMap((update) =>
      update.update.sessionUpdate === "agent_message_chunk"
        ? [(update.update.content as { text?: string }).text ?? ""]
        : [],
    ).join("");
    console.log(JSON.stringify({
      sessionId,
      replayKinds,
      userPromptReplayed,
      keywordReplayed,
      keywordRecalled,
      continuationReply: continuationReply.slice(0, 300),
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
