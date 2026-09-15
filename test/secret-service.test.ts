import assert from "node:assert/strict";
import test from "node:test";

import { createSecretServiceStore } from "../src/integrations/secret-service.js";

test("Secret Service writes secret material on stdin rather than command arguments", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const store = createSecretServiceStore(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    return { exitCode: 0, stdout: "" };
  });

  await store.put("github-pat", "ghp_super_secret");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args.includes("ghp_super_secret"), false);
  assert.equal(calls[0]?.input, "ghp_super_secret");
});

test("Secret Service lookup and deletion fail closed without exposing command output", async () => {
  const store = createSecretServiceStore(async (args) => {
    if (args[0] === "lookup") return { exitCode: 1, stdout: "backend details that must not escape" };
    return { exitCode: 2, stdout: "more backend details" };
  });

  assert.equal(await store.has("missing"), false);
  assert.equal(await store.get("missing"), undefined);
  await assert.rejects(store.delete("missing"), (error: unknown) => {
    assert.equal(error instanceof Error && error.message, "credential service unavailable");
    return true;
  });
});

test("Secret Service distinguishes absent credentials from backend failures without leaking details", async () => {
  const absent = createSecretServiceStore(async () => ({ exitCode: 1, stdout: "", stderr: "" }));
  assert.equal(await absent.get("missing"), undefined);

  const unavailable = createSecretServiceStore(async () => ({ exitCode: 1, stdout: "", stderr: "keyring is locked: sensitive detail" }));
  await assert.rejects(unavailable.get("missing"), (error: unknown) => {
    assert.equal(error instanceof Error && error.message, "credential service unavailable");
    assert.equal(error instanceof Error && error.message.includes("sensitive detail"), false);
    return true;
  });

  const silentFailure = createSecretServiceStore(async () => ({ exitCode: 2, stdout: "", stderr: "" }));
  await assert.rejects(silentFailure.get("missing"), /credential service unavailable/);
});
