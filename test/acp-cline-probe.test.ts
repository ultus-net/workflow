import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";

const runCline = process.env.WORKFLOW_ACP_CLINE === "1";
const authMethodId = process.env.WORKFLOW_ACP_CLINE_AUTH_METHOD;
const useEnvironmentAuth = process.env.WORKFLOW_ACP_CLINE_ENV_AUTH === "1";

if (runCline && !useEnvironmentAuth && process.env.WORKFLOW_ACP_CLINE_USE_EXISTING_CONFIG !== "1" && !authMethodId) {
  throw new Error("Set WORKFLOW_ACP_CLINE_ENV_AUTH=1, WORKFLOW_ACP_CLINE_USE_EXISTING_CONFIG=1, or WORKFLOW_ACP_CLINE_AUTH_METHOD");
}

if (runCline && useEnvironmentAuth && !process.env.CLINE_API_KEY) {
  throw new Error("CLINE_API_KEY is required for WORKFLOW_ACP_CLINE_ENV_AUTH=1; do not paste it into chat");
}

test(
  "Cline ACP auth/session-start probe records bounded handshake evidence",
  { skip: !runCline, timeout: 45_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-cline-"));
    const child = spawn("cline", ["--acp", "--auto-approve", "false", "--cwd", cwd], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    const client = new AcpSubprocessClient({ child });
    const updates: unknown[] = [];
    client.onSessionUpdate((update) => updates.push(update));
    try {
      const started = Date.now();
      const initialized = await client.initialize();
      const afterInitialize = Date.now();
      if (authMethodId) await client.authenticate({ methodId: authMethodId });
      const afterAuthenticate = Date.now();
      const session = await client.newSession({ cwd });
      const afterSession = Date.now();
      const evidence = {
        agent: initialized.agentInfo,
        capabilities: initialized.agentCapabilities,
        sessionId: session.sessionId,
        timingsMs: {
          initialize: afterInitialize - started,
          authenticate: afterAuthenticate - afterInitialize,
          sessionNew: afterSession - afterAuthenticate,
        },
        updates,
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
