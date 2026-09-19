import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fingerprintFile, FileClaimLedger } from "../src/application/file-claim-ledger.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/application/host.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

const task: WorkflowTask = { id: taskId("t"), title: "t", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [] };

test("file fingerprint changes after a write", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-fingerprint-"));
  const path = join(dir, "a.txt");
  writeFileSync(path, "before");
  const before = fingerprintFile(path);
  writeFileSync(path, "after");
  const ledger = new FileClaimLedger();
  ledger.recordRead(before);
  assert.equal(ledger.matchesCurrent(path, before), false);
});

test("file claims are exclusive per session and releaseable", () => {
  const ledger = new FileClaimLedger();
  assert.equal(ledger.claim("a", ["src/a.ts"]), true);
  assert.equal(ledger.claim("b", ["src/a.ts"]), false);
  ledger.release("a");
  assert.equal(ledger.claim("b", ["src/a.ts"]), true);
});

test("read-fingerprint enforcement denies stale writes when enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-fingerprint-auth-"));
  const path = join(dir, "a.txt");
  writeFileSync(path, "before");
  const application = new WorkflowApplication(
    new TaskGraph([task]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true, requireReadFingerprint: true }),
  );
  const fingerprint = fingerprintFile(path);
  application.recordReadFingerprint(fingerprint);
  writeFileSync(path, "changed");
  const decision = application.authorize({
    sessionId: "s", taskId: task.id, tool: "edit", mutating: true,
    subjects: [path], input: {}, readFingerprints: [fingerprint],
  });
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") assert.equal(decision.code, "STALE_OR_MISSING_READ");
});