import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient, type AcpPermissionDecision } from "../src/adapters/acp-subprocess.js";
import type { AcpPermissionRequestParams } from "../src/adapters/acp-permission.js";
import { loadClineApiKey } from "./cline-probe-helpers.js";

const runShellProbe = process.env.WORKFLOW_ACP_CLINE_SHELL === "1";
const denyPermission = process.env.WORKFLOW_ACP_CLINE_DENY === "1";

test(
  "Cline ACP shell probe records process permission behavior for one bounded command",
  { skip: !runShellProbe, timeout: 75_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-cline-shell-"));
    const target = path.join(cwd, "shell-target.txt");
    await writeFile(target, "before\n", "utf8");
    const clineApiKey = await loadClineApiKey("Cline shell probe");
    const child = spawn("cline", ["--acp", "--auto-approve", "false", "--cwd", cwd], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLINE_API_KEY: clineApiKey, CLINE_PROVIDER: process.env.CLINE_PROVIDER ?? "openrouter" },
    });
    const permissionRequests: AcpPermissionRequestParams[] = [];
    const client = new AcpSubprocessClient({
      child,
      async resolvePermission(request): Promise<AcpPermissionDecision> {
        permissionRequests.push(request);
        return denyPermission ? { kind: "deny", reason: "Workflow shell probe denial" } : { kind: "allow" };
      },
    });
    try {
      const initialized = await client.initialize();
      const session = await client.newSession({ cwd });
      const prompt = client.prompt({
        sessionId: session.sessionId,
        prompt: [{
          type: "text",
          text: "Run exactly one shell command to append the text `shell` to shell-target.txt. Do not use file editing tools directly.",
        }],
      });
      const result = await Promise.race([
        prompt,
        new Promise((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 60_000)),
      ]);
      const content = await readFile(target, "utf8");
      console.log(JSON.stringify({
        agent: initialized.agentInfo,
        capabilities: initialized.agentCapabilities,
        sessionId: session.sessionId,
        denyPermission,
        permissionRequests,
        result,
        content,
      }, null, 2));
      assert.equal(initialized.protocolVersion, 1);
      assert.ok(session.sessionId);
    } finally {
      await client.close();
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
