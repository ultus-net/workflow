import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPolicy } from "../src/policy.js";
import { redirectGuidance, DEFAULT_REDIRECT } from "../src/redirect.js";

test("deny reasons are short imperative denials with a tool-class redirect", () => {
  const boundary = checkPolicy({ action: "file_write", path: "/etc/hosts" });
  assert.equal(boundary.decision, "deny");
  assert.match(boundary.reason, /Expected:/);
  assert.match(boundary.reason, /file-write tool/);

  const branch = checkPolicy({ action: "file_write", path: "src/a.ts", currentBranch: "main" });
  assert.equal(branch.decision, "deny");
  assert.match(branch.reason, /feature branch/);

  const role = checkPolicy({ action: "file_write", path: "src/a.ts", trustedRole: "reviewer" });
  assert.equal(role.decision, "deny");
  assert.match(role.reason, /read-class tools/);
});

test("allow decisions are not given redirect text", () => {
  const allowed = checkPolicy({ action: "shell", command: "ls -la" });
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.reason.includes("Expected:"), false);
});

test("the circuit breaker still appends after repeat failures", () => {
  const normal = checkPolicy({ action: "file_write", path: "/etc/hosts" });
  assert.equal(normal.reason.includes("Circuit Breaker"), false);
  const repeat = checkPolicy({ action: "file_write", path: "/etc/hosts", failureCount: 2 });
  assert.equal(repeat.reason.includes("Circuit Breaker"), true);
  assert.match(repeat.reason, /Expected:/);
});

test("unknown policies get the generic tool-class redirect", () => {
  assert.equal(redirectGuidance("policy-that-does-not-exist"), DEFAULT_REDIRECT);
  assert.match(DEFAULT_REDIRECT, /tool class/);
});
