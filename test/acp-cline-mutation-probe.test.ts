import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpSubprocessClient, type AcpPermissionDecision } from "../src/adapters/acp-subprocess.js";

const runClineMutation = process.env.WORKFLOW_ACP_CLINE_MUTATION === "1";
const denyPermission = process.env.WORKFLOW_ACP_CLINE_DENY === "1";
const defaultKeyFile = path.join(homedir(), ".config", "workflow", "cline-api-key");
const keyFile = process.env.CLINE_API_KEY_FILE ?? defaultKeyFile;

async function loadClineApiKey(): Promise<string | undefined> {
  if (process.env.CLINE_API_KEY) return process.env.CLINE_API_KEY;
  try {
    const key = (await readFile(keyFile, "utf8")).trim();
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

if (runClineMutation && !process.env.CLINE_API_KEY && !process.env.CLINE_API_KEY_FILE && !process.env.HOME) {
  throw new Error("CLINE_API_KEY or CLINE_API_KEY_FILE is required for the Cline mutation probe; do not paste it into chat");
}

test(
  "Cline ACP mutation probe records permission behavior for one bounded edit",
  { skip: !runClineMutation, timeout: 60_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "workflow-acp-cline-mutation-"));
    const target = path.join(cwd, "mutation-target.txt");
    await writeFile(target, "before\n", "utf8");
    const clineApiKey = await loadClineApiKey();
    if (!clineApiKey) throw new Error("Cline mutation probe requires CLINE_API_KEY or a readable CLINE_API_KEY_FILE");
    const child = spawn("cline", ["--acp", "--auto-approve", "false", "--cwd", cwd], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLINE_API_KEY: clineApiKey,
        CLINE_PROVIDER: process.env.CLINE_PROVIDER ?? "openrouter",
      },
    });
    const permissionRequests: Record<string, unknown>[] = [];
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
