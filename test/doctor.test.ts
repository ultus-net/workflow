import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkHub,
  checkTopologyGateway,
  checkSettingsDocs,
  checkAgentCredentials,
  checkProbeVerdicts,
  checkContainment,
  checkUpstreamKeyExposure,
  renderDoctorReport,
} from "../src/cli/doctor.js";
import { opencodeServerDiscoveryPath } from "../src/integrations/opencode-server-discovery.js";
import { parseLauncherArgs } from "../src/cli/launcher-args.js";

/**
 * W076 — `workflow doctor`: honest self-checks, pass/warn/fail, actionable
 * fixes, credential VALUES never printed. The topology-gateway and hub
 * checks take injectable fetches (probeOpencodeServerGateway /
 * probeHub); the unit tests pin the pure report composition and the
 * checks that can be driven without daemons.
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

test("doctor: the hub check reads the declared home seam, not the operator's real home", async (t) => {
  // The DoctorOptions.home seam is the doctor's declared way to scope every
  // check to a fake/embedded home; the hub check must honor it like the
  // settings/fleet/posture checks do, so a discovery file in the FAKE home
  // pointing at a dead port is reported as stale — never the operator's
  // real hub state leaking into (or out of) a scoped run.
  const home = mkdtempSync(join(tmpdir(), "wf-doctor-hub-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".workflow", "hub"), { recursive: true });
  writeFileSync(join(home, ".workflow", "hub", "discovery.json"), JSON.stringify({
    hubId: "test-hub",
    endpoint: "http://127.0.0.1:1",
    token: "test-token",
  }));
  const stale = await checkHub({ home });
  assert.equal(stale.status, "fail");
  assert.match(stale.detail, /http:\/\/127\.0\.0\.1:1/);
  assert.match(stale.detail, /nothing answered \/health/);
  assert.match(stale.fix ?? "", /stale discovery file/);
});

test("doctor: the hub check probes through the declared fetchImpl seam, never the raw network", async (t) => {
  // DoctorOptions.fetchImpl is declared on the options and adopted by the
  // topology check; the hub check must honor it too (same seam contract as
  // the home seam above). The pin simulates a LIVE hub on a dead port: the
  // injected fetch answers 200, so `pass` can only come from the injected
  // dependency — the real network would refuse port 1, and pre-fix the
  // injected fetch is never called at all, so this is red regardless of
  // what the operator's machine does with the connection.
  const home = mkdtempSync(join(tmpdir(), "wf-doctor-hubfetch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".workflow", "hub"), { recursive: true });
  writeFileSync(join(home, ".workflow", "hub", "discovery.json"), JSON.stringify({
    hubId: "test-hub",
    endpoint: "http://127.0.0.1:1",
    token: "test-token",
  }));
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  const liveHub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
    return new Response(null, { status: 200 });
  };
  const reachable = await checkHub({ home, fetchImpl: liveHub });
  assert.equal(reachable.status, "pass", reachable.detail);
  assert.match(reachable.detail, /reachable at http:\/\/127\.0\.0\.1:1/);
  assert.equal(calls.length, 1, "the injected fetch answers the one /health probe");
  assert.match(calls[0]?.url ?? "", /\/health$/);
  assert.equal(calls[0]?.authorization, "Bearer test-token");
});

test("doctor: the topology check reads the declared home seam when the env seam is unset", async (t) => {
  // DoctorOptions.home scopes every doctor check that reads a home; the
  // topology check honored only the WORKFLOW_OPENCODE_SERVER_HOME env seam
  // and fell back to the real homedir, so a scoped run could never see (or
  // avoid) its own topology discovery. This pin deletes the env var (saved
  // and restored) to pin the DEFAULT path deterministically: a discovery
  // file for a fresh temp workspace exists only in the FAKE home, so a
  // stale gateway (injected fetch answering 503) must be reported as fail —
  // pre-fix the check read the real home and found nothing (warn).
  const savedEnv = process.env.WORKFLOW_OPENCODE_SERVER_HOME;
  delete process.env.WORKFLOW_OPENCODE_SERVER_HOME;
  t.after(() => {
    if (savedEnv !== undefined) process.env.WORKFLOW_OPENCODE_SERVER_HOME = savedEnv;
  });
  const home = mkdtempSync(join(tmpdir(), "wf-doctor-topo-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-doctor-topo-ws-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  // The state-home root composes as <home>/.workflow/opencode-server (the
  // env seam's value is consumed the same way); the discovery file is keyed
  // per workspace inside it.
  const stateHome = join(home, ".workflow", "opencode-server");
  mkdirSync(stateHome, { recursive: true });
  writeFileSync(opencodeServerDiscoveryPath(stateHome, workspace), JSON.stringify({
    protocol: 1,
    pid: 4242,
    workspace,
    gatewayUrl: "http://127.0.0.1:1",
    tuiUsername: "tui",
    tuiPassword: "pw",
  }));
  const stale = await checkTopologyGateway({ home, workspace, fetchImpl: async () => new Response(null, { status: 503 }) });
  assert.equal(stale.status, "fail");
  assert.match(stale.detail, /http:\/\/127\.0\.0\.1:1/);
  assert.match(stale.detail, /nothing answered/);
  // The hub-check lesson: a dead-port gateway alone cannot pin the
  // fetchImpl forwarding (a dropped seam would still fail via real-network
  // refusal), so the same discovery also proves the LIVE path — the
  // injected fetch answers 200 on the dead port, and only the forwarded
  // seam can produce a pass.
  let topologyProbed = 0;
  const liveTopology = async (): Promise<Response> => {
    topologyProbed += 1;
    // The gateway health contract (W072): GET /api/info answers
    // {version, ...} — the v1 /global/health fallback is never reached.
    return Response.json({ version: "test" }, { status: 200 });
  };
  const live = await checkTopologyGateway({ home, workspace, fetchImpl: liveTopology });
  assert.equal(live.status, "pass", live.detail);
  assert.match(live.detail, /gateway live at http:\/\/127\.0\.0\.1:1/);
  assert.equal(topologyProbed, 1, "the injected fetch answered the one gateway probe");
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

test("doctor (C1 F2): a uid-shared plane upstream key in the process environment fails, and the value is never printed", () => {
  const clean = checkUpstreamKeyExposure({} as NodeJS.ProcessEnv);
  assert.equal(clean.status, "pass");

  // Off the plane the env is the operator's own process — a documented source,
  // not a uid-shared leak.
  const offPlane = checkUpstreamKeyExposure({ WORKFLOW_UPSTREAM_KEY: "sk-or-v1-supersecretvalue" } as NodeJS.ProcessEnv);
  assert.equal(offPlane.status, "pass");
  assert.match(offPlane.detail, /not a uid-shared plane/);

  // On the plane (WORKFLOW_PLANE=1) the same env is readable by any same-uid
  // agent tool process — a fail with the seam fix and the rotation action.
  const leaked = checkUpstreamKeyExposure({ WORKFLOW_PLANE: "1", WORKFLOW_UPSTREAM_KEY: "sk-or-v1-supersecretvalue" } as NodeJS.ProcessEnv);
  assert.equal(leaked.status, "fail");
  assert.match(leaked.detail, /WORKFLOW_UPSTREAM_KEY/);
  assert.match(leaked.detail, /\/proc\/<pid>\/environ/);
  assert.match(leaked.fix ?? "", /rotate it/);
  // The check must never echo the secret it is warning about.
  assert.doesNotMatch(leaked.detail, /supersecretvalue/);
  assert.doesNotMatch(leaked.fix ?? "", /supersecretvalue/);
});
