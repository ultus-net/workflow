import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";

test("ACP session runs end-to-end with the agent process inside the containment boundary", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "workflow-acp-contained-ws-"));
  const home = await mkdtemp(path.join(tmpdir(), "workflow-acp-contained-home-"));
  const fixture = path.resolve("test/fixtures/fake-acp-agent.mjs");
  const child = launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
    executable: process.execPath,
    script: fixture,
    args: ["permission"],
    workspace,
    home,
    readablePaths: [path.dirname(fixture)],
  });
  const client = new AcpSubprocessClient({
    child,
    resolvePermission: () => ({ kind: "allow" }),
  });
  try {
    const initialized = await client.initialize();
    assert.equal(initialized.protocolVersion, 1);
    const session = await client.newSession({ cwd: workspace });
    const result = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "edit" }] });
    assert.deepEqual(result, { stopReason: "end_turn", permissionOutcome: "allow-1" });
  } finally {
    await client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
