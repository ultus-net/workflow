import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseRsiArgs, readVerifierDiscovery } from "../src/cli/rsi.js";

/**
 * W073 operator trigger: `workflow-rsi` argument parsing. The client holds no
 * authority; it only shapes the hub `/rsi/*` request.
 */

test("start parses the objective, limits, and optional controls into a spec", () => {
  const parsed = parseRsiArgs([
    "start",
    "--workspace", "/repo",
    "--objective", "reduce flaky tests",
    "--max-iterations", "4",
    "--no-review",
    "--budget", "2.5",
    "--direction", "lower",
    "--baseline", "20",
    "--max-consecutive-rejections", "2",
  ]);
  assert.equal(parsed.command, "start");
  assert.equal(parsed.workspace, "/repo");
  assert.deepEqual(parsed.spec, {
    workspace: "/repo",
    objective: "reduce flaky tests",
    maxIterations: 4,
    requiresReview: false,
    budgetUsd: 2.5,
    direction: "lower",
    baselineScore: 20,
    maxConsecutiveRejections: 2,
  });
});

test("the review gate is on unless explicitly opted out with --no-review", () => {
  const defaulted = parseRsiArgs(["start", "--workspace", "/r", "--objective", "o", "--max-iterations", "1"]);
  assert.equal(defaulted.spec?.requiresReview, undefined, "omitting the flag leaves the hub default (review on) intact");
});

test("start requires workspace, objective, and max-iterations", () => {
  assert.throws(() => parseRsiArgs(["start", "--workspace", "/repo"]), /requires --workspace, --objective, and --max-iterations/);
});

test("cancel requires an id or a workspace; status optionally takes an id", () => {
  assert.throws(() => parseRsiArgs(["cancel"]), /requires --id or --workspace/);
  assert.equal(parseRsiArgs(["cancel", "--id", "rsi-loop:1"]).id, "rsi-loop:1");
  assert.equal(parseRsiArgs(["cancel", "--workspace", "/repo"]).workspace, "/repo");
  assert.equal(parseRsiArgs(["status"]).id, undefined);
  assert.equal(parseRsiArgs(["status", "--id", "rsi-loop:2"]).id, "rsi-loop:2");
});

test("unknown commands, bad directions, and stray arguments fail closed", () => {
  assert.throws(() => parseRsiArgs(["launch"]), /unknown command/);
  assert.throws(() => parseRsiArgs(["start", "--workspace", "/r", "--objective", "o", "--max-iterations", "1", "--direction", "sideways"]), /higher or lower/);
  assert.throws(() => parseRsiArgs(["status", "surprise"]), /unexpected argument/);
});

test("the discovery directory defaults to the data dir and honours WORKFLOW_HUB_DIR", () => {
  const explicit = parseRsiArgs(["status", "--discovery-dir", "/custom"], {});
  assert.equal(explicit.discoveryDir, "/custom");
  const fromEnv = parseRsiArgs(["status"], { WORKFLOW_HUB_DIR: "/from-env" });
  assert.equal(fromEnv.discoveryDir, "/from-env");
});

test("readVerifierDiscovery reads verifier.json, fails closed on absence or malformed content", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-rsi-verifier-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hubDir = join(dir, "hub");
  mkdirSync(hubDir, { recursive: true });
  writeFileSync(join(hubDir, "verifier.json"), JSON.stringify({ protocol: 1, endpoint: "http://127.0.0.1:1", token: "v-token" }));

  const resolved = readVerifierDiscovery(dir);
  assert.equal(resolved.url, "http://127.0.0.1:1");
  assert.equal(resolved.token, "v-token");

  assert.throws(() => readVerifierDiscovery(join(dir, "missing")), /verifier discovery/);
  writeFileSync(join(hubDir, "verifier.json"), "{}");
  assert.throws(() => readVerifierDiscovery(dir), /malformed/);
});