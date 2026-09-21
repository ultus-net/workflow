import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkSettingsDocs,
  checkAgentCredentials,
  checkProbeVerdicts,
  checkContainment,
  renderDoctorReport,
} from "../src/cli/doctor.js";
import { parseLauncherArgs } from "../src/cli/launcher-args.js";

/**
 * W076 — `workflow doctor`: honest self-checks, pass/warn/fail, actionable
 * fixes, credential VALUES never printed. The topology-gateway check takes an
 * injectable fetch; the hub check uses probeHub directly. The unit tests pin
 * the pure report composition and the checks that can be driven without
 * daemons.
 */

test("doctor: the doctor verb parses as a utility surface and is absent from the display picker", () => {
  assert.equal(parseLauncherArgs(["doctor"]).verb, "doctor");
  assert.throws(() => parseLauncherArgs(["serve"]), TypeError);
});

test("doctor: settings check parses both scopes and reports the honest detail", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-doctor-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-doctor-ws-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  mkdirSync(join(home, ".config", "workflow"), { recursive: true });
  writeFileSync(join(home, ".config", "workflow", "settings.json"), JSON.stringify({
    mcpServers: [{ name: "guard", enabled: true, transport: "stdio", command: "node" }],
  }));
  const ok = checkSettingsDocs({ home, workspace });
  assert.equal(ok.status, "pass");
  assert.match(ok.detail, /1 mcp servers/);

  // A corrupt file fails with the actionable fix, never a silent pass.
  writeFileSync(join(home, ".config", "workflow", "settings.json"), "{not json");
  const broken = checkSettingsDocs({ home, workspace });
  assert.equal(broken.status, "fail");
  assert.match(broken.detail, /do not parse/);
  assert.match(broken.fix ?? "", /fix the JSON/);
});

test("doctor: credential checks state availability with reasons, never values", () => {
  const checks = checkAgentCredentials();
  assert.equal(checks.length, 3, "one check per switcher agent");
  for (const check of checks) {
    assert.ok(!/\b(sk-|key)[A-Za-z0-9_-]{8,}/.test(check.detail), `no credential values in ${check.name}`);
  }
  // The detail carries the reason the UI would show (booleans + reason only).
  const unavailable = checks.filter((check) => check.status === "fail");
  for (const check of unavailable) assert.match(check.detail, /unavailable — /);
});

test("doctor: the probe verdict register check states the honest register state", () => {
  // Driven by the shipped register (anti-drift is pinned in
  // test/probe-verdict-register.test.ts); this pin holds the doctor
  // composition: the register is named, the write-up doc stays pointed at,
  // and nothing is fabricated.
  const check = checkProbeVerdicts();
  assert.ok(["pass", "warn"].includes(check.status));
  assert.match(check.detail, /docs\/PROBE_VERDICTS\.json/);
  assert.match(check.detail, /docs\/HOST_ADAPTERS\.md/);
  assert.doesNotMatch(check.detail, /sk-[A-Za-z0-9]{8,}/, "never a credential value");
});

test("doctor: the containment backend report states enforced-capable, missing-bwrap, and policy-only honestly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-doctor-bwrap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Linux with a real bwrap binary at the probed path → enforced-capable.
  const bwrap = join(dir, "bwrap");
  writeFileSync(bwrap, "");
  const enforced = checkContainment({ platform: "linux", bwrapPath: bwrap });
  assert.equal(enforced.status, "pass");
  assert.match(enforced.detail, /bubblewrap present/);
  assert.match(enforced.detail, /enforced filesystem boundary/);

  // Linux without bwrap is a WARN (contained launches fail closed at spawn),
  // never a silent pass — the actionable fix names the package.
  const missing = checkContainment({ platform: "linux", bwrapPath: join(dir, "absent-bwrap") });
  assert.equal(missing.status, "warn");
  assert.match(missing.detail, /bwrap was not found/);
  assert.match(missing.detail, /fail closed at spawn/);
  assert.match(missing.fix ?? "", /install bubblewrap/);

  // Non-Linux is the typed policy-only passthrough, stated with its limit.
  const policyOnly = checkContainment({ platform: "darwin", bwrapPath: bwrap });
  assert.equal(policyOnly.status, "warn");
  assert.match(policyOnly.detail, /policy gating only/);
  assert.match(policyOnly.detail, /never claimed as enforced/);
  assert.match(policyOnly.fix ?? "", /Linux-only/);
});

test("doctor: the report renders icons, fixes, and never truncates a failure", () => {
  const report = renderDoctorReport([
    { name: "a", status: "pass", detail: "fine" },
    { name: "b", status: "warn", detail: "not running", fix: "start it" },
    { name: "c", status: "fail", detail: "broken", fix: "fix it" },
  ]);
  assert.match(report, /✓ a: fine/);
  assert.match(report, /! b: not running/);
  assert.match(report, / {6}fix: start it/);
  assert.match(report, /✗ c: broken/);
  assert.match(report, / {6}fix: fix it/);
});
