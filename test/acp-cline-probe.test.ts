import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";
import { clineLaunchEntry, loadClineApiKey } from "./cline-probe-helpers.js";

const runCline = process.env.WORKFLOW_ACP_CLINE === "1";
const authMethodId = process.env.WORKFLOW_ACP_CLINE_AUTH_METHOD;
const useEnvironmentAuth = process.env.WORKFLOW_ACP_CLINE_ENV_AUTH === "1";

if (runCline && !useEnvironmentAuth && process.env.WORKFLOW_ACP_CLINE_USE_EXISTING_CONFIG !== "1" && !authMethodId) {
  throw new Error("Set WORKFLOW_ACP_CLINE_ENV_AUTH=1, WORKFLOW_ACP_CLINE_USE_EXISTING_CONFIG=1, or WORKFLOW_ACP_CLINE_AUTH_METHOD");
}

test(
  "Cline ACP auth/session-start probe records bounded handshake evidence",
  { skip: !runCline, timeout: 45_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-cline-"));
    // Env-key auth is a vendored-surface capability: stock PATH cline
    // (3.0.62) is account-cloud-only in ACP mode and cannot authenticate
    // headlessly, so the env-auth mode launches the vendored pinned entry
    // (docs/ACP_RESEARCH.md). The auth-method and existing-config modes keep
    // the stock PATH launch — they probe the stock surface's other routes.
    const vendored = useEnvironmentAuth ? clineLaunchEntry() : undefined;
    const clineApiKey = useEnvironmentAuth ? await loadClineApiKey("Cline handshake probe") : undefined;
    const child = spawn(
      vendored?.executable ?? "cline",
      [
        ...(vendored?.script !== undefined ? [vendored.script] : []),
        "--acp",
        ...(useEnvironmentAuth ? ["--provider", "openrouter"] : []),
        "--auto-approve",
        "false",
        "--cwd",
        cwd,
      ],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(clineApiKey === undefined
            ? {}
            : { CLINE_API_KEY: clineApiKey, CLINE_PROVIDER: process.env.CLINE_PROVIDER ?? "openrouter" }),
        },
      },
    );
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
