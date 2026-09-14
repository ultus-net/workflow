import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

import { AcpSubprocessClient } from "../src/adapters/acp-subprocess.js";
import type { AcpPermissionRequestParams } from "../src/adapters/acp-permission.js";

function fakePermissionAgent(mode: "permission" | "permission-no-reject" | "permission-string-id"): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["test/fixtures/fake-acp-agent.mjs", mode], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function runScenario(
  mode: "permission" | "permission-no-reject" | "permission-string-id",
  decision: { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string },
) {
  const child = fakePermissionAgent(mode);
  const client = new AcpSubprocessClient({
    child,
    async resolvePermission() {
      return decision;
    },
  });
  try {
    await client.initialize();
    const session = await client.newSession({ cwd: "/repo" });
    return await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "edit" }] });
  } finally {
    await client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
}

test("ACP subprocess client routes inbound permission requests to the configured resolver", async () => {
  assert.deepEqual(await runScenario("permission", { kind: "allow" }), {
    stopReason: "end_turn",
    permissionOutcome: "allow-1",
  });
});

test("ACP subprocess client hands the resolver the permission request params, not the JSON-RPC envelope", async () => {
  const child = fakePermissionAgent("permission");
  const seen: AcpPermissionRequestParams[] = [];
  const client = new AcpSubprocessClient({
    child,
    resolvePermission(request) {
      seen.push(request);
      return { kind: "allow" };
    },
  });
  try {
    await client.initialize();
    const session = await client.newSession({ cwd: "/repo" });
    await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "edit" }] });
  } finally {
    await client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.sessionId, "fake-session-1");
  assert.equal((seen[0]?.toolCall as Record<string, unknown> | undefined)?.toolCallId, "tool-permission-1");
  assert.ok(Array.isArray(seen[0]?.options));
  assert.equal("jsonrpc" in seen[0]!, false);
  assert.equal("method" in seen[0]!, false);
});

test("ACP subprocess client maps resolver denial to an agent-provided rejecting option", async () => {
  assert.deepEqual(await runScenario("permission", { kind: "deny", reason: "policy denied" }), {
    stopReason: "end_turn",
    permissionOutcome: "reject-1",
  });
});

test("ACP subprocess client fails closed when denial has no rejecting option to select", async () => {
  assert.deepEqual(await runScenario("permission-no-reject", { kind: "deny", reason: "policy denied" }), {
    stopReason: "cancelled",
    failClosedReason: "no_reject_option",
  });
});

test("ACP subprocess client answers inbound permission requests with string JSON-RPC ids", async () => {
  assert.deepEqual(await runScenario("permission-string-id", { kind: "allow" }), {
    stopReason: "end_turn",
    permissionOutcome: "allow-1",
  });
});

test("ACP subprocess client default resolver denies inbound permission requests", async () => {
  const child = fakePermissionAgent("permission");
  const client = new AcpSubprocessClient({ child });
  try {
    await client.initialize();
    const session = await client.newSession({ cwd: "/repo" });
    const result = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "edit" }] });
    assert.deepEqual(result, { stopReason: "end_turn", permissionOutcome: "reject-1" });
  } finally {
    await client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
});
