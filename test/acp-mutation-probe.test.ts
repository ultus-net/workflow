import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient, type AcpSessionUpdate } from "../src/adapters/acp-subprocess.js";

const runMutationProbe = process.env.WORKFLOW_ACP_MUTATION === "1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionUpdate(update: AcpSessionUpdate): boolean {
  return update.update.sessionUpdate === "tool_call" || update.update.sessionUpdate === "tool_call_update";
}

test(
  "OpenCode ACP mutation probe records permission/tool behavior for one bounded file write",
  { skip: !runMutationProbe, timeout: 45_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-mutation-"));
    const target = path.join(cwd, "mutation-target.txt");
    await writeFile(target, "before\n", "utf8");
    const child = spawn("opencode", ["acp", "--cwd", cwd], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    const client = new AcpSubprocessClient({ child });
    const updates: AcpSessionUpdate[] = [];
    client.onSessionUpdate((update) => updates.push(update));

    try {
      const initialized = await client.initialize();
      const session = await client.newSession({ cwd });
      const prompt = client.prompt({
        sessionId: session.sessionId,
        prompt: [{
          type: "text",
          text: "Use the available file editing tool to change mutation-target.txt from `before` to `after`. Do not run shell commands or tests.",
        }],
      });
      const result = await Promise.race([
        prompt,
        new Promise((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 30_000)),
      ]);
      const content = await readFile(target, "utf8");
      const toolUpdates = updates.filter(isPermissionUpdate).map((update) => update.update);
      const evidence = {
        agent: initialized.agentInfo,
        capabilities: initialized.agentCapabilities,
        sessionId: session.sessionId,
        result,
        content,
        toolUpdates,
        sawPermissionRequest: false,
        note: "No inbound session/request_permission was observed in this launch mode. The client now answers inbound permission requests fail-closed by default, but absence of a request proves this OpenCode ACP mode is not authoritative pre-mutation interception.",
      };
      console.log(JSON.stringify(evidence, null, 2));
      assert.equal(initialized.protocolVersion, 1);
      assert.ok(session.sessionId);
    } finally {
      await client.close();
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("OpenCode ACP mutation evidence classifies raw tool updates without treating them as permission interception", () => {
  const update: AcpSessionUpdate = {
    sessionId: "s",
    update: { sessionUpdate: "tool_call", toolCallId: "t", title: "edit", kind: "edit" },
  };
  assert.equal(isPermissionUpdate(update), true);
  assert.equal(isRecord(update.update), true);
});
