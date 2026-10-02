import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EgressPolicyFileError, loadEgressPolicyFile } from "../src/integrations/egress-policy-file.js";

/**
 * W183: the activation seam for the `network: "proxied"` posture. The loader
 * turns an operator-provided JSON file into a validated `EgressPolicy`:
 * absent path/file means "no proxied policy" (the launcher keeps the host
 * posture), and a PRESENT-but-invalid file fails closed (`EgressPolicyFileError`)
 * so a malformed policy can never silently become an allow-all proxy.
 */

function withFile(contents: string): { readonly path: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-policy-"));
  const path = join(dir, "policy.json");
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W183 loadEgressPolicyFile returns undefined when no path is configured", () => {
  assert.equal(loadEgressPolicyFile(undefined), undefined);
  assert.equal(loadEgressPolicyFile(""), undefined);
  assert.equal(loadEgressPolicyFile("   "), undefined);
});

test("W183 loadEgressPolicyFile returns undefined when the configured file does not exist", () => {
  // Absent file is not an error: no policy means the launcher keeps host.
  assert.equal(loadEgressPolicyFile("/nonexistent/wf-egress-policy.json"), undefined);
});

test("W183 loadEgressPolicyFile fails closed on a relative path", () => {
  assert.throws(() => loadEgressPolicyFile("relative/policy.json"), EgressPolicyFileError);
});

test("W183 loadEgressPolicyFile loads and validates a well-formed policy", () => {
  const { path, cleanup } = withFile(JSON.stringify({ rules: [{ id: "allow", host: "api.example.com", port: 443, methods: ["POST"], paths: ["/v1"], mode: "enforce" }] }));
  try {
    const policy = loadEgressPolicyFile(path);
    assert.notEqual(policy, undefined);
    assert.deepEqual(policy?.rules, [{ id: "allow", host: "api.example.com", port: 443, methods: ["POST"], paths: ["/v1"], mode: "enforce" }]);
  } finally {
    cleanup();
  }
});

test("W183 loadEgressPolicyFile fails closed on malformed JSON", () => {
  const { path, cleanup } = withFile("{ not json");
  try {
    assert.throws(() => loadEgressPolicyFile(path), EgressPolicyFileError);
  } finally {
    cleanup();
  }
});

test("W183 loadEgressPolicyFile fails closed on a shape violation", () => {
  const { path, cleanup } = withFile(JSON.stringify({ nope: true }));
  try {
    assert.throws(() => loadEgressPolicyFile(path), EgressPolicyFileError);
  } finally {
    cleanup();
  }
});

test("W183 loadEgressPolicyFile fails closed on a rule missing host/mode", () => {
  const { path, cleanup } = withFile(JSON.stringify({ rules: [{ port: 443 }] }));
  try {
    assert.throws(() => loadEgressPolicyFile(path), EgressPolicyFileError);
  } finally {
    cleanup();
  }
});

test("W183 loadEgressPolicyFile fails closed on a policy W178 validation rejects", () => {
  // Overlapping rules that disagree on mode is a W178 `mode_conflict`.
  const { path, cleanup } = withFile(JSON.stringify({ rules: [
    { id: "a", host: "api.example.com", mode: "enforce" },
    { id: "b", host: "api.example.com", mode: "audit" },
  ] }));
  try {
    assert.throws(() => loadEgressPolicyFile(path), EgressPolicyFileError);
  } finally {
    cleanup();
  }
});
