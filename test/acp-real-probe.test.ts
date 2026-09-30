import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";
import { clineLaunchEntry, loadClineApiKey } from "./cline-probe-helpers.js";
import { spawnOpencodeAcp } from "./opencode-probe-helpers.js";

const runReal = process.env.WORKFLOW_ACP_REAL === "1";

/** The arm supplies its own child: opencode via the version-aware helper
 * (cwd through spawn options), cline via its `--acp ... --cwd` CLI shape. */
async function probe(launch: (cwd: string) => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>, promptTimeoutMs = 20_000) {
  const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-probe-"));
  await writeFile(path.join(cwd, "README.md"), "# ACP probe fixture\n");
  const child = await launch(cwd);
  const client = new AcpSubprocessClient({ child });
  const updates: unknown[] = [];
  client.onSessionUpdate((update) => updates.push(update));
  try {
    const initialized = await client.initialize();
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
  const evidence = await probe((cwd) => spawnOpencodeAcp(cwd));
  assert.equal(evidence.initialized.agentInfo?.name, "OpenCode");
  assert.equal(evidence.initialized.protocolVersion, 1);
  assert.ok(evidence.session.sessionId);
  console.log(JSON.stringify({ agent: "opencode", ...evidence }, null, 2));
});

test("real cline --acp initializes and completes a read-only prompt probe", { skip: !runReal, timeout: 30_000 }, async () => {
  // The established testing path: the vendored patched Cline binary with
  // CLI provider flags plus CLINE_API_KEY env, matching the other Cline
  // probes. The stock PATH cline only authenticates via its account cloud
  // and cannot run headless API-key sessions.
  const clineApiKey = await loadClineApiKey("real cline probe");
  const cline = clineLaunchEntry();
  // Cline's `--acp` accepts `--cwd`, so the cline arm keeps its CLI shape
  // (unlike opencode, whose helper sets cwd through spawn options).
  const evidence = await probe(
    (cwd) => spawn(
      cline.executable,
      [
        ...(cline.script !== undefined ? [cline.script] : []),
        "--acp",
        "--provider",
        "openrouter",
        "--auto-approve",
        "false",
        "--cwd",
        cwd,
      ],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLINE_API_KEY: clineApiKey, CLINE_PROVIDER: "openrouter" },
      },
    ),
    20_000,
  );
  assert.equal(evidence.initialized.agentInfo?.name, "cline");
  assert.equal(evidence.initialized.protocolVersion, 1);
  assert.ok(evidence.session.sessionId);
  console.log(JSON.stringify({ agent: "cline", ...evidence }, null, 2));
});
