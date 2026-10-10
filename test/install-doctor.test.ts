import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  compareFleet,
  fleetCopyCommand,
  fleetTarget,
  installFleet,
  loadFleetManifest,
  parseInstallArgs,
} from "../src/integrations/fleet-payload.js";
import { checkFleetPayload, checkGuardPosture } from "../src/cli/doctor.js";

/**
 * W086 — the control-plane fleet payload: vendored assets + committed
 * manifest, the doctor's fleet/enforcement-posture checks, and the
 * operator-invoked installer. Hermetic: every test builds its own tiny fleet
 * fixture; only the manifest-drift guard reads the real vendored assets.
 */

function sha256(payload: string | Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

function makeFleetFixture(t: { after: (fn: () => void) => void }, entries: Array<{ id: string; kind: "agent" | "command" | "doc"; file: string; body: string }>): {
  root: string;
  home: string;
  workspace: string;
} {
  const root = mkdtempSync(join(tmpdir(), "wf-fleet-root-"));
  const home = mkdtempSync(join(tmpdir(), "wf-fleet-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-fleet-ws-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const dirFor = (kind: string): string => join(root, "assets", "opencode-fleet", kind === "agent" ? "agents" : kind === "command" ? "commands" : "docs");
  for (const entry of entries) {
    const dir = dirFor(entry.kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, entry.file), entry.body);
  }
  const manifest = {
    version: 1,
    entries: entries.map((entry) => ({ id: entry.id, kind: entry.kind, file: entry.file, sha256: sha256(entry.body) })),
  };
  mkdirSync(join(root, "assets", "opencode-fleet"), { recursive: true });
  writeFileSync(join(root, "assets", "opencode-fleet", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { root, home, workspace };
}

test("the committed fleet manifest matches the vendored assets exactly (drift guard)", () => {
  const manifest = loadFleetManifest();
  const dirs: Record<string, string> = { agent: "agents", command: "commands", doc: "docs" };
  const onDisk = new Map<string, string>();
  for (const [kind, dir] of Object.entries(dirs)) {
    const dirPath = join("assets", "opencode-fleet", dir);
    for (const file of readdirSync(dirPath)) {
      if (file.endsWith(".md")) onDisk.set(kind + ":" + file.replace(/\.md$/, ""), sha256(readFileSync(join(dirPath, file))));
    }
  }
  assert.ok(manifest.entries.length >= 12, `the fleet vendors its full payload (got ${manifest.entries.length})`);
  for (const entry of manifest.entries) {
    assert.equal(entry.sha256, onDisk.get(entry.id), `manifest sha256 for ${entry.id} matches the vendored file`);
    onDisk.delete(entry.id);
  }
  assert.equal(onDisk.size, 0, "every vendored file is listed in the manifest (no unlisted strays)");
});

test("compareFleet reports missing before install and current after", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { id: "agent:probe", kind: "agent", file: "probe.md", body: "agent body\n" },
    { id: "command:probe", kind: "command", file: "probe.md", body: "command body\n" },
    { id: "doc:probe", kind: "doc", file: "probe.md", body: "doc body\n" },
  ]);
  const options = { root, home, workspace };
  assert.deepEqual(
    compareFleet(options).map((status) => status.state),
    ["missing", "missing", "missing"],
  );
  installFleet(options);
  assert.deepEqual(
    compareFleet(options).map((status) => status.state),
    ["current", "current", "current"],
  );
  assert.equal(fleetTarget({ id: "doc:probe", kind: "doc", file: "probe.md", sha256: "x" }, { workspace }), join(workspace, "docs", "agents", "probe.md"));
});

test("the installer refuses to clobber local edits; force overrides agents/commands but never docs", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { id: "agent:probe", kind: "agent", file: "probe.md", body: "agent body\n" },
    { id: "doc:probe", kind: "doc", file: "probe.md", body: "doc body\n" },
  ]);
  const options = { root, home, workspace };
  installFleet(options);
  const agentTarget = join(home, ".config", "opencode", "agents", "probe.md");
  const docTarget = join(workspace, "docs", "agents", "probe.md");
  writeFileSync(agentTarget, "operator edit\n");
  writeFileSync(docTarget, "repo-owned edit\n");

  const plain = installFleet(options);
  assert.deepEqual(
    plain.map((result) => result.action).sort(),
    ["skipped-local-modified", "skipped-repo-doc"],
    "local edits are skipped, never silently overwritten",
  );
  assert.equal(readFileSync(agentTarget, "utf8"), "operator edit\n");
  assert.equal(readFileSync(docTarget, "utf8"), "repo-owned edit\n");

  const forced = installFleet({ ...options, force: true });
  assert.deepEqual(
    forced.map((result) => result.action).sort(),
    ["forced", "skipped-repo-doc"],
    "force overrides agents/commands but docs stay repo-owned even under force",
  );
  assert.equal(readFileSync(agentTarget, "utf8"), "agent body\n");
  assert.equal(readFileSync(docTarget, "utf8"), "repo-owned edit\n");

  const configAgentsDir = join(home, ".config", "opencode", "agents");
  assert.equal(readdirSync(configAgentsDir).filter((file) => file.includes(".tmp")).length, 0, "no staging files left behind");
});

test("the doctor fleet check fails with actionable commands when entries are missing", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { id: "agent:probe", kind: "agent", file: "probe.md", body: "agent body\n" },
  ]);
  const missing = checkFleetPayload({ home, workspace, root });
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /missing: agent:probe/);
  assert.ok(missing.fix, "a failure names the fix");
  assert.match(missing.fix ?? "", /workflow install fleet/);
  assert.match(missing.fix ?? "", /cp '/, "the fix carries the exact hand-copy commands");
  assert.match(missing.fix ?? "", /probe\.md/);

  installFleet({ root, home, workspace });
  const current = checkFleetPayload({ home, workspace, root });
  assert.equal(current.status, "pass");
  assert.match(current.detail, /1\/1 entries installed and matching/);
});

test("the doctor fleet check warns on drift and never overclaims doc overwrites", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { id: "agent:probe", kind: "agent", file: "probe.md", body: "agent body\n" },
    { id: "doc:probe", kind: "doc", file: "probe.md", body: "doc body\n" },
  ]);
  installFleet({ root, home, workspace });
  writeFileSync(join(home, ".config", "opencode", "agents", "probe.md"), "operator edit\n");
  writeFileSync(join(workspace, "docs", "agents", "probe.md"), "repo edit\n");
  const drifted = checkFleetPayload({ home, workspace, root });
  assert.equal(drifted.status, "warn");
  assert.match(drifted.detail, /differs from the vendored version/);
  assert.match(drifted.fix ?? "", /NEVER overwritten/);
  assert.match(drifted.fix ?? "", /--force/);
});

test("the doctor fleet check fails closed on a malformed manifest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wf-fleet-bad-"));
  const home = mkdtempSync(join(tmpdir(), "wf-fleet-badhome-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(root, "assets", "opencode-fleet"), { recursive: true });
  writeFileSync(join(root, "assets", "opencode-fleet", "manifest.json"), "{\"version\": 7, \"entries\": []}\n");
  const check = checkFleetPayload({ home, root });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /failed validation/);
  assert.match(check.fix ?? "", /generate-fleet-manifest/);
});

test("the enforcement-posture check reads the host config honestly and never edits it", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-posture-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const absent = checkGuardPosture({ home });
  assert.equal(absent.status, "pass");
  assert.match(absent.detail, /no host config document/);

  const configDir = join(home, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "opencode.jsonc"), "// operator config\n\"plugins\": [\"opencode-workflow-guard@1.13.3\"],\n");
  const present = checkGuardPosture({ home });
  assert.equal(present.status, "warn");
  assert.match(present.detail, /still registers the workflow-guard plugin/);
  assert.match(present.detail, /not yet probe-verified/, "no parity claim the register does not carry");
  assert.match(present.fix ?? "", /operator edit/, "the fix is an operator edit, never an installer write");

  writeFileSync(join(configDir, "opencode.jsonc"), "// operator config\n\"model\": \"x\"\n");
  const clean = checkGuardPosture({ home });
  assert.equal(clean.status, "pass");
  assert.match(clean.detail, /plugin-free posture/);
  assert.match(clean.detail, /raw host launches are unguarded by design/, "the honest residual stays stated");
});

test("the installer confines to requested kinds (kinds filter)", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { id: "agent:probe", kind: "agent", file: "probe.md", body: "agent body\n" },
    { id: "command:probe", kind: "command", file: "probe.md", body: "command body\n" },
    { id: "doc:probe", kind: "doc", file: "probe.md", body: "doc body\n" },
  ]);
  const options = { root, home, workspace, kinds: ["agent", "command"] as const };
  assert.deepEqual(
    compareFleet(options).map((status) => status.entry.kind),
    ["agent", "command"],
    "compare reports only the requested kinds",
  );
  installFleet(options);
  const agentTarget = join(home, ".config", "opencode", "agents", "probe.md");
  const commandTarget = join(home, ".config", "opencode", "commands", "probe.md");
  const docTarget = join(workspace, "docs", "agents", "probe.md");
  assert.ok(existsSync(agentTarget), "requested agent kind installs");
  assert.ok(existsSync(commandTarget), "requested command kind installs");
  assert.ok(!existsSync(docTarget), "the excluded doc kind is never written");
});

test("the default posture check reads the real home and states the recorded posture", () => {
  const check = checkGuardPosture({ home: homedir() });
  assert.ok(check.detail.length > 0);
  assert.ok(!/parity verified|plugin-free enforcement is enforced/i.test(check.detail), "no unverified enforcement claims");
});

test("install argument parsing fails closed", () => {
  assert.deepEqual(parseInstallArgs(["fleet"]), { item: "fleet", force: false });
  assert.deepEqual(parseInstallArgs(["fleet", "--force"]), { item: "fleet", force: true });
  assert.equal(parseInstallArgs([]).error, "workflow install requires an item: fleet (usage: workflow install fleet [--force])");
  assert.match(parseInstallArgs(["fleet", "extra"]).error ?? "", /unrecognized argument/);
  assert.equal(parseInstallArgs(["--force"]).item, undefined);
});

test("the copy command is shell-quoted and carries both absolute paths", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { id: "agent:probe", kind: "agent", file: "probe.md", body: "agent body\n" },
  ]);
  const status = compareFleet({ root, home, workspace })[0];
  assert.ok(status);
  const command = fleetCopyCommand(status, { root });
  assert.match(command, /^cp '[^']+' '[^']+'$/);
  assert.match(command, /assets\/opencode-fleet\/agents\/probe\.md/);
  assert.match(command, /opencode\/agents\/probe\.md/);
  assert.ok(existsSync(join(root, "assets", "opencode-fleet", "agents", "probe.md")), "the printed source path exists");
});
