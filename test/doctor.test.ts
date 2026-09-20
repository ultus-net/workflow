import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkSettingsDocs,
  checkAgentCredentials,
  checkProbeGates,
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

test("doctor: probe gates list the families and which are armed", (t) => {
  const previous = process.env.WORKFLOW_OPENCODE_WEBUI_PROBE;
  process.env.WORKFLOW_OPENCODE_WEBUI_PROBE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_OPENCODE_WEBUI_PROBE;
    else process.env.WORKFLOW_OPENCODE_WEBUI_PROBE = previous;
  });
  const check = checkProbeGates();
  assert.equal(check.status, "pass");
  assert.match(check.detail, /1\/8 gates armed/);
  assert.match(check.detail, /WORKFLOW_OPENCODE_WEBUI_PROBE/);
  assert.match(check.detail, /docs\/HOST_ADAPTERS\.md/, "verdicts are pointed at, never fabricated");
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
