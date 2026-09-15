import { spawn } from "node:child_process";

import type { SecretStore } from "./credentials.js";

type SecretToolResult = { exitCode: number; stdout: string; stderr?: string };
type SecretToolRunner = (args: string[], input?: string) => Promise<SecretToolResult>;

const SERVICE = "workflow";

export function createSecretServiceStore(run: SecretToolRunner = runSecretTool): SecretStore {
  async function lookup(id: string): Promise<string | undefined> {
    const result = await run(["lookup", "service", SERVICE, "credential", id]);
    if (result.exitCode === 1 && !result.stderr?.trim()) return undefined;
    if (result.exitCode !== 0) throw unavailableService();
    return result.stdout.replace(/\r?\n$/, "");
  }

  return {
    async has(id): Promise<boolean> {
      return (await lookup(id)) !== undefined;
    },
    get: lookup,
    async put(id, value): Promise<void> {
      const result = await run(
        ["store", "--label", `Workflow credential ${id}`, "service", SERVICE, "credential", id],
        value,
      );
      if (result.exitCode !== 0) throw unavailableService();
    },
    async delete(id): Promise<void> {
      const result = await run(["clear", "service", SERVICE, "credential", id]);
      if (result.exitCode !== 0) throw unavailableService();
    },
  };
}

function runSecretTool(args: string[], input?: string): Promise<SecretToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", () => reject(unavailableService()));
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

function unavailableService(): Error {
  return new Error("credential service unavailable");
}
