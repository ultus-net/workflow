import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function rawMcpCall(binary: string, cwd: string, env: Record<string, string>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = spawn(binary, [], { cwd, env: { HOME: process.env.HOME ?? cwd, PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = ""; const responses = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>; const id = message.id;
      if (typeof id === "number") { responses.get(id)?.(message); responses.delete(id); }
    }
  });
  const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => { responses.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  try {
    const initialized = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-cross-harness-receiver", version: "1.0.0" } }); assert.ok(initialized.result);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const response = await request(2, "tools/call", { name, arguments: args }); assert.ok(response.result); return response.result as Record<string, unknown>;
  } finally { child.stdin.end(); child.kill(); }
}

test("packed npm artifact transfers verification evidence across independent MCP sessions", async () => {
  const temp = mkdtempSync(join(tmpdir(), "verification-accountability-package-"));
  try {
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const consumer = join(temp, "consumer"); const workspace = join(temp, "workspace"); const dataRoot = join(temp, "data"); mkdirSync(consumer); mkdirSync(workspace);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" }); execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "verification-accountability-mcp", "package.json"), "utf8")) as { bin?: Record<string, string>; dependencies?: Record<string, string> };
    assert.deepEqual(installed.bin, { "verification-accountability-mcp": "./dist/server.js" }); assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "verification-accountability-mcp"); accessSync(binary, constants.X_OK);
    const authority = join(process.cwd(), "test", "fake-authority.mjs");
    const authorityEnv = { VERIFICATION_ACCOUNTABILITY_DATA_DIR: dataRoot, VERIFICATION_ACCOUNTABILITY_CI_COMMAND: process.execPath, VERIFICATION_ACCOUNTABILITY_CI_ARGS: JSON.stringify([authority]), CI_GITHUB_REPOSITORY: "owner/repo" };
    const producer = new Client({ name: "verification-producer", version: "1.0.0" });
    try { await producer.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe", env: authorityEnv })); const recorded = await producer.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "ci_run", runId: "github:42", revision: "d".repeat(40) } } }); assert.equal(recorded.isError, undefined); }
    finally { await producer.close(); }
    const result = await rawMcpCall(binary, consumer, authorityEnv, "list_verifications", { workspaceRoot: workspace, currentSubject: { kind: "ci_revision", provider: "github", repository: "owner/repo", revision: "d".repeat(40) } });
    assert.equal(((result.structuredContent as { observations: Array<{ freshness: string }> }).observations[0]?.freshness), "fresh");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
