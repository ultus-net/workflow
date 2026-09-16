import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient, type AcpPermissionDecision } from "../src/adapters/acp-subprocess.js";
import type { AcpPermissionRequestParams } from "../src/adapters/acp-permission.js";
import { clineLaunchEntry, loadClineApiKey } from "./cline-probe-helpers.js";

const runClineMutation = process.env.WORKFLOW_ACP_CLINE_MUTATION === "1";
const denyPermission = process.env.WORKFLOW_ACP_CLINE_DENY === "1";

/**
 * Records permission behavior for one bounded edit against the vendored
 * pinned Cline ACP surface. The probe launches the vendored entry via
 * `clineLaunchEntry()` with `--provider openrouter` plus key env: stock PATH
 * cline (3.0.62) is account-cloud-only in ACP mode and cannot authenticate
 * headlessly (`docs/ACP_RESEARCH.md`) — the pre-retarget live run only
 * passed by riding the ambient real-HOME account session on the stock
 * binary, which is machine-specific evidence, not a headless path.
 */

test(
  "Cline ACP mutation probe records permission behavior for one bounded edit",
  { skip: !runClineMutation, timeout: 60_000 },
  async () => {
    const clineApiKey = await loadClineApiKey("Cline mutation probe");
    const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-cline-mutation-"));
    const target = path.join(cwd, "mutation-target.txt");
    await writeFile(target, "before\n", "utf8");
    const cline = clineLaunchEntry();
    const child = spawn(
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
        env: {
          ...process.env,
          CLINE_API_KEY: clineApiKey,
          CLINE_PROVIDER: process.env.CLINE_PROVIDER ?? "openrouter",
        },
      },
    );
    const permissionRequests: AcpPermissionRequestParams[] = [];
    const client = new AcpSubprocessClient({
      child,
      async resolvePermission(request): Promise<AcpPermissionDecision> {
        permissionRequests.push(request);
        return denyPermission ? { kind: "deny", reason: "Workflow probe denial" } : { kind: "allow" };
      },
    });
    try {
      const initialized = await client.initialize();
      const session = await client.newSession({ cwd });
      const prompt = client.prompt({
        sessionId: session.sessionId,
        prompt: [{
          type: "text",
          text: "Edit mutation-target.txt by replacing `before` with `after`. Do not run shell commands or tests.",
        }],
      });
      const result = await Promise.race([
        prompt,
        new Promise((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), 45_000)),
      ]);
      const content = await readFile(target, "utf8");
      const evidence = {
        agent: initialized.agentInfo,
        capabilities: initialized.agentCapabilities,
        sessionId: session.sessionId,
        denyPermission,
        permissionRequests,
        result,
        content,
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
