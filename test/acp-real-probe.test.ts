import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";

const runReal = process.env.WORKFLOW_ACP_REAL === "1";

async function probe(command: string, args: string[], authMethodId?: string, promptTimeoutMs = 20_000) {
  const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-probe-"));
  await writeFile(path.join(cwd, "README.md"), "# ACP probe fixture\n");
  const child = spawn(command, [...args, "--cwd", cwd], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const client = new AcpSubprocessClient({ child });
  const updates: unknown[] = [];
  client.onSessionUpdate((update) => updates.push(update));
  try {
    const initialized = await client.initialize();
    if (authMethodId) await client.authenticate({ methodId: authMethodId });
    const session = await client.newSession({ cwd });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Read README.md and report only the title. Do not modify files." }],
    });
    const result = await Promise.race([
      prompt,
      new Promise((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), promptTimeoutMs)),
    ]);
    return { initialized, session, updates, result };
  } finally {
    await client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await rm(cwd, { recursive: true, force: true });
  }
}

test("real opencode acp initializes and completes a read-only prompt probe", { skip: !runReal, timeout: 30_000 }, async () => {
  const evidence = await probe("opencode", ["acp"]);
  assert.equal(evidence.initialized.agentInfo.name, "OpenCode");
  assert.equal(evidence.initialized.protocolVersion, 1);
  assert.ok(evidence.session.sessionId);
  console.log(JSON.stringify({ agent: "opencode", ...evidence }, null, 2));
});

test("real cline --acp initializes and completes a read-only prompt probe", { skip: !runReal, timeout: 30_000 }, async () => {
  const evidence = await probe("cline", ["--acp", "--auto-approve", "false"], "cline", 12_000);
  assert.equal(evidence.initialized.agentInfo.name, "cline");
  assert.equal(evidence.initialized.protocolVersion, 1);
  assert.ok(evidence.session.sessionId);
  console.log(JSON.stringify({ agent: "cline", ...evidence }, null, 2));
});
