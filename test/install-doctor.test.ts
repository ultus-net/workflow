import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  compareFleet,
  fleetCopyCommand,
  fleetTarget,
  installFleet,
  loadFleetManifest,
  parseInstallArgs,
  type FleetKind,
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

/** The vendored source subdirectory per kind — mirrors scripts/generate-fleet-manifest.mjs. */
const KIND_DIR: Record<FleetKind, string> = {
  agent: "agents",
  command: "commands",
  doc: "docs",
  instruction: "instructions",
  style: "style",
  template: "templates",
  skill: "skills",
  lib: "lib",
  "host-config": "host-config",
};
const RECURSIVE_KINDS: readonly FleetKind[] = ["template", "skill", "lib"];
const EXT_KINDS: Record<FleetKind, readonly string[]> = {
  agent: ["md"],
  command: ["md"],
  doc: ["md"],
  instruction: ["md"],
  style: ["md"],
  template: ["md"],
  skill: ["md", "txt", "json"],
  lib: ["cjs", "sh", "ts", ""],
  "host-config": ["json", "jsonc"],
};

function makeFleetFixture(
  t: { after: (fn: () => void) => void },
  entries: Array<{ kind: FleetKind; file: string; body: string }>,
): { root: string; home: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "wf-fleet-root-"));
  const home = mkdtempSync(join(tmpdir(), "wf-fleet-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-fleet-ws-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const entry of entries) {
    const dir = join(root, "assets", "opencode-fleet", KIND_DIR[entry.kind]);
    mkdirSync(dirnameOf(join(dir, entry.file)), { recursive: true });
    writeFileSync(join(dir, entry.file), entry.body);
  }
  const manifest = {
    version: 1,
    entries: entries.map((entry) => ({ id: `${entry.kind}:${entry.file}`, kind: entry.kind, file: entry.file, sha256: sha256(entry.body) })),
  };
  mkdirSync(join(root, "assets", "opencode-fleet"), { recursive: true });
  writeFileSync(join(root, "assets", "opencode-fleet", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { root, home, workspace };
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : ".";
}

/** Directory-relative POSIX path of every manifest-eligible file under a kind dir (generator logic, re-run). */
function walkKind(dirPath: string, kind: FleetKind): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (RECURSIVE_KINDS.includes(kind)) found.push(...walkKind(full, kind));
      continue;
    }
    const suffix = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".") + 1) : "";
    if (EXT_KINDS[kind].includes(suffix)) found.push(full);
  }
  return found;
}

test("the committed fleet manifest matches the vendored assets exactly (drift guard)", () => {
  const manifest = loadFleetManifest();
  const onDisk = new Map<string, string>();
  for (const kind of Object.keys(KIND_DIR) as FleetKind[]) {
    const dirPath = join("assets", "opencode-fleet", KIND_DIR[kind]);
    const base = join("assets", "opencode-fleet", KIND_DIR[kind]);
    for (const file of walkKind(dirPath, kind)) {
      onDisk.set(`${kind}:${relative(base, file).split("\\").join("/")}`, sha256(readFileSync(file)));
    }
  }
  assert.ok(manifest.entries.length >= 60, `the fleet vendors its full golden tree (got ${manifest.entries.length})`);
  for (const entry of manifest.entries) {
    assert.equal(entry.sha256, onDisk.get(entry.id), `manifest sha256 for ${entry.id} matches the vendored file`);
    onDisk.delete(entry.id);
  }
  assert.equal(onDisk.size, 0, "every vendored file is listed in the manifest (no unlisted strays)");
});

test("compareFleet reports missing before install and current after", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { kind: "agent", file: "probe.md", body: "agent body\n" },
    { kind: "command", file: "probe.md", body: "command body\n" },
    { kind: "doc", file: "probe.md", body: "doc body\n" },
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
  assert.equal(fleetTarget({ id: "doc:probe.md", kind: "doc", file: "probe.md", sha256: "x" }, { workspace }), join(workspace, "docs", "agents", "probe.md"));
});

test("the installer refuses to clobber local edits; force overrides agents/commands but never docs", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { kind: "agent", file: "probe.md", body: "agent body\n" },
    { kind: "doc", file: "probe.md", body: "doc body\n" },
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

test("the installer deploys every golden-tree kind to its host-config path (instructions, style, template, skill, lib)", (t) => {
  const { root, home } = makeFleetFixture(t, [
    { kind: "instruction", file: "STANDARDS.md", body: "standards\n" },
    { kind: "style", file: "coding-style.md", body: "style\n" },
    { kind: "template", file: "rsi/ledger.md", body: "ledger template\n" },
    { kind: "skill", file: "code-cheatsheet/SKILL.md", body: "skill\n" },
    { kind: "skill", file: "code-cheatsheet/template.md", body: "skill template\n" },
    { kind: "lib", file: "validate-lessons.cjs", body: "module.exports = {};\n" },
    { kind: "lib", file: "vendor/LICENSE-opencode-src", body: "license\n" },
  ]);
  installFleet({ root, home });
  const cfg = join(home, ".config", "opencode");
  assert.ok(existsSync(join(cfg, "STANDARDS.md")), "a flat instruction installs at the config-dir root");
  assert.ok(existsSync(join(cfg, "style", "coding-style.md")), "style installs under style/");
  assert.ok(existsSync(join(cfg, "templates", "rsi", "ledger.md")), "a nested template recreates its subdirectory");
  assert.ok(existsSync(join(cfg, "skills", "code-cheatsheet", "SKILL.md")), "a nested skill recreates its subdirectory");
  assert.ok(existsSync(join(cfg, "skills", "code-cheatsheet", "template.md")), "every skill asset installs, not only SKILL.md");
  assert.ok(existsSync(join(cfg, "lib", "validate-lessons.cjs")), "a lib ruler installs under lib/");
  assert.ok(existsSync(join(cfg, "lib", "vendor", "LICENSE-opencode-src")), "a nested, extensionless lib asset installs too");
  assert.deepEqual(
    compareFleet({ root, home }).map((status) => status.state),
    ["current", "current", "current", "current", "current", "current", "current"],
  );
});

test("the reference-only host-config kind is never compared or installed", (t) => {
  const { root, home } = makeFleetFixture(t, [
    { kind: "host-config", file: "config.jsonc", body: "{}\n" },
    { kind: "agent", file: "probe.md", body: "agent body\n" },
  ]);
  assert.deepEqual(
    compareFleet({ root, home }).map((status) => status.entry.kind),
    ["agent"],
    "the default view excludes the reference-only kind",
  );
  installFleet({ root, home });
  assert.ok(!existsSync(join(home, ".config", "opencode", "config.jsonc")), "the installer never writes the permission surface");
  assert.deepEqual(
    compareFleet({ root, home, kinds: ["host-config"] }).map((status) => status.entry.kind),
    [],
    "even an explicit request cannot install the reference-only kind",
  );
});

test("the doctor fleet check fails with actionable commands when entries are missing", (t) => {
  const { root, home, workspace } = makeFleetFixture(t, [
    { kind: "agent", file: "probe.md", body: "agent body\n" },
  ]);
  const missing = checkFleetPayload({ home, workspace, root });
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /missing: agent:probe\.md/);
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
    { kind: "agent", file: "probe.md", body: "agent body\n" },
    { kind: "doc", file: "probe.md", body: "doc body\n" },
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

test("the doctor fleet check fails closed on a manifest file path that escapes its kind dir", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wf-fleet-escape-"));
  const home = mkdtempSync(join(tmpdir(), "wf-fleet-escapehome-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(root, "assets", "opencode-fleet"), { recursive: true });
  writeFileSync(
    join(root, "assets", "opencode-fleet", "manifest.json"),
    JSON.stringify({ version: 1, entries: [{ id: "agent:x", kind: "agent", file: "../../../etc/passwd", sha256: sha256("x") }] }),
  );
  const check = checkFleetPayload({ home, root });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /unsafe file path/);
});

test("the doctor fleet check fails closed on other unsafe manifest file paths (absolute, backslash, dot segments)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-fleet-unsafehome-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const file of ["/etc/passwd", "dir\\sub\\file.md", "./probe.md", "a/../b.md"]) {
    const root = mkdtempSync(join(tmpdir(), "wf-fleet-unsafe-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "assets", "opencode-fleet"), { recursive: true });
    writeFileSync(
      join(root, "assets", "opencode-fleet", "manifest.json"),
      JSON.stringify({ version: 1, entries: [{ id: "agent:x", kind: "agent", file, sha256: sha256("x") }] }),
    );
    const check = checkFleetPayload({ home, root });
    assert.equal(check.status, "fail", `unsafe file path ${JSON.stringify(file)} must fail closed`);
    assert.match(check.detail, /unsafe file path/);
  }
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
    { kind: "agent", file: "probe.md", body: "agent body\n" },
    { kind: "command", file: "probe.md", body: "command body\n" },
    { kind: "doc", file: "probe.md", body: "doc body\n" },
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
    { kind: "agent", file: "probe.md", body: "agent body\n" },
  ]);
  const status = compareFleet({ root, home, workspace })[0];
  assert.ok(status);
  const command = fleetCopyCommand(status, { root });
  assert.match(command, /^mkdir -p '[^']+' && cp '[^']+' '[^']+'$/);
  assert.match(command, /assets\/opencode-fleet\/agents\/probe\.md/);
  assert.match(command, /opencode\/agents\/probe\.md/);
  assert.ok(existsSync(join(root, "assets", "opencode-fleet", "agents", "probe.md")), "the printed source path exists");
});

test("the copy command mkdir -p's the parent of a nested target", (t) => {
  const { root, workspace } = makeFleetFixture(t, [
    { kind: "template", file: "rsi/ledger.md", body: "ledger template\n" },
  ]);
  const status = compareFleet({ root, workspace, home: workspace })[0];
  assert.ok(status);
  const command = fleetCopyCommand(status, { root });
  assert.match(command, /^mkdir -p '.+opencode\/templates\/rsi' && cp /);
  assert.match(command, /templates\/rsi\/ledger\.md/);
});
