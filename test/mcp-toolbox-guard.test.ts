import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createCredentialBroker, InMemorySecretStore } from "../src/integrations/credentials.js";
import { guardInputFromToolCall, guardPolicyEvidence } from "../src/integrations/mcp-toolbox-guard.js";
import { createWorkflowGuardMcpProvider } from "../src/integrations/mcp-toolbox-guard.js";

const serverPath = resolve(process.cwd(), "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js");

function ensureBuilt(): void {
  if (existsSync(serverPath)) return;
  execFileSync("pnpm", ["--dir", "mcp-toolbox", "--filter", "workflow-guard-mcp", "run", "build"], { stdio: "inherit" });
}

test("guardPolicyEvidence maps decisions onto normalized MCP evidence", () => {
  const allow = guardPolicyEvidence({ decision: "allow", policy: "shell.safe", reason: "ok" }, 3);
  assert.equal(allow.result, "passed");
  assert.equal(allow.authority, "mcp");
  assert.equal(allow.subject, "policy:shell.safe");
  assert.equal(allow.mutationEpoch, 3);

  const deny = guardPolicyEvidence({ decision: "deny", policy: "shell.destructive", reason: "no" }, 4);
  assert.equal(deny.result, "failed");
});

test("workflow-guard-mcp provider discovers and invokes guard_check over stdio", async (t) => {
  ensureBuilt();
  const provider = await createWorkflowGuardMcpProvider({ serverPath });
  t.after(() => provider.close());

  const capabilities = await provider.capabilities();
  assert.deepEqual(capabilities.map((cap) => cap.name).sort(), ["guard_check", "guard_status"]);

  const allowed = await provider.guardCheck({ action: "shell", command: "ls -la" });
  assert.equal(allowed.decision, "allow");

  const denied = await provider.guardCheck({ action: "shell", command: "rm -rf /" });
  assert.equal(denied.decision, "deny");

  const status = await provider.guardStatus();
  assert.equal(status.mode, "policy-advisor");
});

test("workflow-guard-mcp child receives only explicitly brokered credential environment", async (t) => {
  ensureBuilt();
  const directory = mkdtempSync(resolve(tmpdir(), "workflow-mcp-env-"));
  const probePath = resolve(directory, "env.json");
  const wrapperPath = resolve(directory, "server.mjs");
  writeFileSync(wrapperPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(probePath)}, JSON.stringify(process.env));`,
    `await import(${JSON.stringify(pathToFileURL(serverPath).href)});`,
  ].join("\n"));

  const store = new InMemorySecretStore();
  await store.put("guard-token", "brokered-value");
  const broker = createCredentialBroker(store, [{
    id: "guard-token",
    label: "Guard token",
    kind: "token",
    allowedConsumers: ["mcp:workflow-guard"],
    allowedPurposes: ["stdio-env:WORKFLOW_GUARD_TOKEN"],
    workspace: process.cwd(),
  }]);
  const ambientName = "WORKFLOW_AMBIENT_SENTINEL";
  const previousAmbient = process.env[ambientName];
  process.env[ambientName] = "must-not-reach-child";
  t.after(() => {
    if (previousAmbient === undefined) delete process.env[ambientName];
    else process.env[ambientName] = previousAmbient;
  });

  const provider = await createWorkflowGuardMcpProvider({
    serverPath: wrapperPath,
    credentialBroker: broker,
    credentialBindings: [{ variable: "WORKFLOW_GUARD_TOKEN", reference: "secret://guard-token" }],
    workspace: process.cwd(),
  });
  t.after(() => provider.close());
  assert.equal((await provider.guardStatus()).mode, "policy-advisor");

  const childEnv = JSON.parse(readFileSync(probePath, "utf8")) as Record<string, string>;
  assert.equal(childEnv.WORKFLOW_GUARD_TOKEN, "brokered-value");
  assert.equal(childEnv[ambientName], undefined);
});

// ── Plan Task G2: shared tool-call → guard-input mapping ────────────────────

test("guardInputFromToolCall maps every host family to guard actions", () => {
  // Cline hook surface
  assert.deepEqual(guardInputFromToolCall("execute_command", { command: "git status" }), { action: "shell", command: "git status" });
  assert.deepEqual(guardInputFromToolCall("write_to_file", { path: "src/a.ts", content: "let x = 1;" }), { action: "file_write", path: "src/a.ts", content: "let x = 1;" });
  // ACP approval surface
  assert.deepEqual(guardInputFromToolCall("run_commands", { commands: ["git status", { command: "make", args: ["build"] }] }), { action: "shell", command: "git status; make build" });
  assert.deepEqual(guardInputFromToolCall("replace_in_file", { path: "a.ts", diff: "@@ -1 +1 @@" }), { action: "file_write", path: "a.ts", patchText: "@@ -1 +1 @@" });
  // OpenCode surface — edit/write must carry the content, never an empty payload
  assert.deepEqual(guardInputFromToolCall("edit", { filePath: "src/a.ts", newString: "let y = 2;" }), { action: "file_write", path: "src/a.ts", content: "let y = 2;" });
  assert.deepEqual(guardInputFromToolCall("write", { filePath: "src/b.ts", content: "export {};" }), { action: "file_write", path: "src/b.ts", content: "export {};" });
  assert.deepEqual(guardInputFromToolCall("apply_patch", { patchText: "*** Update File: x" }), { action: "file_write", patchText: "*** Update File: x" });
  assert.deepEqual(guardInputFromToolCall("bash", { command: "echo hi" }), { action: "shell", command: "echo hi" });
  // Network tools reach the guard with the target URL
  assert.deepEqual(guardInputFromToolCall("webfetch", { url: "https://example.internal" }), { action: "network", command: "https://example.internal" });
  // Unmapped tools stay out of the guard entirely
  assert.equal(guardInputFromToolCall("search_codebase", { query: "x" }), undefined);
  // workspaceRoot scoping applies to every mapped action
  assert.deepEqual(guardInputFromToolCall("write", { filePath: "a.ts", content: "x" }, "/repo"), { action: "file_write", path: "a.ts", content: "x", workspaceRoot: "/repo" });
});
