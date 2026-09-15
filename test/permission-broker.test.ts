import assert from "node:assert/strict";
import test from "node:test";

import { PermissionBroker } from "../src/ui/permission-broker.js";
import type { ProposedToolAction } from "../src/application/host.js";

function action(tool: string, overrides: Partial<ProposedToolAction> = {}): ProposedToolAction {
  return {
    sessionId: "session",
    taskId: "T1" as never,
    tool,
    mutating: true,
    subjects: [],
    input: { command: "ls" },
    ...overrides,
  };
}

function allowAll(): (candidate: ProposedToolAction) => { kind: "allow" } {
  return () => ({ kind: "allow" });
}

function denyAll(reason: string): (candidate: ProposedToolAction) => { kind: "deny"; code: string; reason: string } {
  return () => ({ kind: "deny", code: "TEST", reason });
}

test("auto mode passes straight through to the hub policy", async () => {
  const broker = new PermissionBroker();
  assert.equal(broker.mode(), "auto");
  assert.deepEqual(await broker.intercept(action("run_commands"), allowAll()), { kind: "allow" });
  assert.deepEqual(await broker.intercept(action("run_commands"), denyAll("nope")), {
    kind: "deny",
    code: "TEST",
    reason: "nope",
  });
  assert.equal(broker.pendingRequest(), undefined, "auto mode never parks");
});

test("ask mode parks allowed requests and resolves them by answer", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const pending = broker.intercept(action("run_commands", { subjects: ["src/"] }), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  const request = broker.pendingRequest();
  assert.ok(request !== undefined, "the request parks for the operator");
  assert.equal(request.tool, "run_commands");
  assert.deepEqual(request.subjects, ["src/"]);
  assert.equal(broker.answer("wrong-id", "allow_once"), false, "a stale id fails closed");
  assert.equal(broker.answer(request.id, "allow_once"), true);
  assert.deepEqual(await pending, { kind: "allow" });
  assert.equal(broker.pendingRequest(), undefined, "answering clears the parked slot");
});

test("ask mode never prompts for hard policy denials", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const decision = broker.intercept(action("run_commands"), denyAll("capability withheld"));
  assert.deepEqual(await decision, { kind: "deny", code: "TEST", reason: "capability withheld" });
  assert.equal(broker.pendingRequest(), undefined);
});

test("always patterns bypass or block without prompting", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");

  const first = broker.intercept(action("run_commands"), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.answer(broker.pendingRequest()!.id, "allow_always"), true);
  assert.deepEqual(await first, { kind: "allow" });

  // The remembered allow skips the prompt but still consults the policy.
  assert.deepEqual(await broker.intercept(action("run_commands"), allowAll()), { kind: "allow" });
  const denied = await broker.intercept(action("run_commands"), denyAll("workspace"));
  assert.equal(denied.kind, "deny", "always-allow never overrides a policy denial");

  const second = broker.intercept(action("web_search"), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.answer(broker.pendingRequest()!.id, "reject_always"), true);
  assert.equal(denied.kind, "deny");
  assert.deepEqual(await second, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator (always)" });
  const rejected = await broker.intercept(action("web_search"), allowAll());
  assert.equal(rejected.kind, "deny");
  assert.equal(broker.pendingRequest(), undefined, "always-reject never parks");

  assert.deepEqual(broker.patterns(), { alwaysAllow: ["run_commands"], alwaysReject: ["web_search"] });
  broker.resetPatterns();
  assert.deepEqual(broker.patterns(), { alwaysAllow: [], alwaysReject: [] });
});

test("a second concurrent request fails closed while one is parked", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const first = broker.intercept(action("run_commands"), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  const second = await broker.intercept(action("read_file"), allowAll());
  assert.equal(second.kind, "deny");
  broker.answer(broker.pendingRequest()!.id, "allow_once");
  assert.deepEqual(await first, { kind: "allow" });
});

test("cancelling a parked request and switching modes deny it", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const parked = broker.intercept(action("run_commands"), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  broker.cancelPending("turn cancelled");
  assert.deepEqual(await parked, { kind: "deny", code: "PROMPT_CANCELLED", reason: "turn cancelled" });

  const parkedAgain = broker.intercept(action("run_commands"), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  broker.setMode("auto");
  assert.equal((await parkedAgain).kind, "deny", "switching back to auto resolves the parked request as a denial");
  assert.equal(broker.mode(), "auto");
});

test("parked request carries a capped input preview", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  void broker.intercept(action("run_commands", { input: { command: "x".repeat(64 * 1024) } }), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  const request = broker.pendingRequest();
  assert.ok(request !== undefined);
  assert.ok(request.inputPreview !== undefined && request.inputPreview.length < 4 * 1024);
  broker.answer(request.id, "reject_once");
});