import assert from "node:assert/strict";
import test from "node:test";

import { hostCapabilities } from "../src/adapters/host.js";
import { createContainedShellExecutor } from "../src/integrations/contained-shell-executor.js";

// W144: the bounded-execute option on the contained-shell executor. The
// executor's contract is FORWARDING only — it never sees the child handle, so
// the kill lives in the BACKEND (the process-group SIGKILL + the named
// timeout error are pinned at the backend layer in test/containment.test.ts
// and test/platform-containment.test.ts, and end-to-end in
// test/e2e-hub-bash.test.ts). This file pins the forwarding contract: the cap
// reaches the backend as request.timeoutMs, the agent tool lane (no option)
// forwards NO field, and the executor resolves whenever the backend settles.

const fakeResult = { exitCode: 0, stdout: "", stderr: "", enforcement: "policy-only", network: "isolated", credentials: "cleared" };

test("W144: the executor forwards timeoutMs into the contained request", async () => {
  let seen: { timeoutMs?: number } | undefined;
  const backend = {
    execute: async (_action: unknown, request: { timeoutMs?: number }) => {
      seen = request;
      return fakeResult;
    },
  } as never;
  const executor = createContainedShellExecutor(backend, {
    capabilities: hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    sessionId: "workflow-tui",
    taskId: "T1" as never,
    timeoutMs: 4321,
  });
  await executor("/bin/echo", "/tmp", undefined);
  assert.equal(seen?.timeoutMs, 4321, "the cap reaches the backend as request.timeoutMs");
});

test("W144: an executor without the option forwards NO timeoutMs field (the agent tool lane's posture is untouched)", async () => {
  let seen: { timeoutMs?: number } | undefined;
  const backend = {
    execute: async (_action: unknown, request: { timeoutMs?: number }) => {
      seen = request;
      return fakeResult;
    },
  } as never;
  const executor = createContainedShellExecutor(backend, {
    capabilities: hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    sessionId: "workflow-tui",
    taskId: "T1" as never,
  });
  await executor("/bin/echo", "/tmp", undefined);
  assert.equal(seen?.timeoutMs, undefined, "no cap field reaches the backend without the option");
});

test("W144: without the cap the executor keeps its unbounded posture (the option does not silently widen)", async () => {
  // A backend that settles LATE but normally: with no timeoutMs the executor
  // awaits it exactly as before — the timeout machinery must not engage.
  const backend = {
    execute: async () => ({ exitCode: 0, stdout: "late", stderr: "", enforcement: "policy-only", network: "isolated", credentials: "cleared" }),
  } as never;
  const executor = createContainedShellExecutor(backend, {
    capabilities: hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    sessionId: "workflow-tui",
    taskId: "T1" as never,
  });
  const outcome = await executor("/bin/echo", "/tmp", undefined);
  assert.equal(outcome, "late");
});