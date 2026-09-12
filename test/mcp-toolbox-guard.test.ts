import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { guardPolicyEvidence } from "../src/integrations/mcp-toolbox-guard.js";
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
