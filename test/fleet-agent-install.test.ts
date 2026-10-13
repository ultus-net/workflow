import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareFleet,
  fleetAssetsRoot,
  installFleetIntoOpencodeConfig,
  loadFleetManifest,
  provisionFleetSkills,
  RUNTIME_FLEET_KINDS,
  runtimeFleetTransform,
  type FleetKind,
} from "../src/integrations/fleet-payload.js";
import { foldFleetAmbientDocs, normalizeFleetAgentPayload, rewriteFleetModelRef } from "../src/integrations/fleet-agent-install.js";
import {
  FLEET_TIER_MODEL_IDS,
  meteredOpencodeConfig,
  OPENCODE_METERED_PROVIDER_ID,
  OPENCODE_V2_METERED_PROVIDER_ID,
  v2BuiltinModelRef,
} from "../src/integrations/opencode-agent-config.js";

/**
 * The fleet plane-compat install transform (2026-10-13). The vendored agents
 * carry two constructs the control plane cannot honor — a `synthetic/` model
 * pin (no such provider is registered) and `external_directory` permission
 * actions (unmappable in the ACP adapter). The runtime-lane install normalizes
 * BOTH at install time, so the vendored SOURCE stays byte-identical. These
 * tests pin the transform, the widened runtime kind set, the store provisioned
 * skills, the resolved tier pins, and the doctor's agreement with the runtime
 * tree.
 */

const sha256 = (payload: Buffer | string): string => createHash("sha256").update(payload).digest("hex");

// ── the pure transform ──────────────────────────────────────────────────────

test("rewriteFleetModelRef re-points only the synthetic/ provider prefix", () => {
  assert.equal(rewriteFleetModelRef("synthetic/syn:small:text"), `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:small:text`);
  assert.equal(rewriteFleetModelRef("synthetic/syn:large:text"), `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:large:text`);
  assert.equal(rewriteFleetModelRef("openrouter/auto"), "openrouter/auto", "an already-metered ref is untouched");
  assert.equal(rewriteFleetModelRef("anthropic/claude-sonnet-4"), "anthropic/claude-sonnet-4", "an operator ref is untouched");
});

test("normalizeFleetAgentPayload rewrites the model pin and strips external_directory, preserving everything else", () => {
  const source = [
    "---",
    "description: a probe agent",
    "mode: subagent",
    "model: synthetic/syn:small:text",
    "steps: 30",
    "permissions:",
    "  - action: edit",
    "    resource: \"*\"",
    "    effect: deny",
    "  - action: external_directory",
    "    resource: \"~/.config/opencode/style/**\"",
    "    effect: allow",
    "  - action: subagent",
    "    resource: \"*\"",
    "    effect: deny",
    "---",
    "",
    "Body text stays exactly as written.",
    "",
  ].join("\n");
  const out = normalizeFleetAgentPayload(Buffer.from(source)).toString("utf8");
  assert.ok(out.includes(`model: ${OPENCODE_V2_METERED_PROVIDER_ID}/syn:small:text`), "the model pin provider is rewritten");
  assert.ok(!out.includes("external_directory"), "the unmappable action is stripped");
  assert.ok(out.includes("  - action: edit"), "a sibling permission rule is preserved");
  assert.ok(out.includes("  - action: subagent"), "a later sibling permission rule is preserved");
  assert.ok(out.includes("Body text stays exactly as written."), "the document body is untouched");
  // The two-line external_directory item is fully gone (head + body), not left dangling.
  assert.equal(out.split("\n").filter((line) => line.includes("~/.config/opencode/style")).length, 0);
});

test("normalizeFleetAgentPayload leaves a doc with no frontmatter untouched", () => {
  const bare = Buffer.from("# no frontmatter\n\nbody\n");
  assert.equal(normalizeFleetAgentPayload(bare).toString("utf8"), bare.toString("utf8"));
});

// ── the runtime lane's widened install ──────────────────────────────────────

test("installFleetIntoOpencodeConfig installs the runtime config kinds and never docs/host-config/skills files", () => {
  const configDir = mkdtempSync(join(tmpdir(), "wf-fleet-runtime-"));
  try {
    const results = installFleetIntoOpencodeConfig(configDir);
    const manifest = loadFleetManifest();
    const expected = manifest.entries.filter((entry) => (RUNTIME_FLEET_KINDS as readonly FleetKind[]).includes(entry.kind));
    assert.deepEqual(
      [...new Set(results.map((result) => result.entry.kind))].sort(),
      ["agent", "command", "instruction", "style", "template"],
      "the runtime lane installs exactly the config-dir dependency kinds",
    );
    assert.equal(results.length, expected.length);
    for (const kind of ["agent", "command", "instruction", "style", "template"] as const) {
      assert.ok(expected.some((entry) => entry.kind === kind), `the vendored fleet carries ${kind} entries`);
    }
    for (const absent of ["doc", "host-config", "skill", "lib"] as const) {
      assert.ok(!results.some((result) => result.entry.kind === absent), `${absent} is never in the runtime config-dir install`);
    }
    assert.ok(!existsSync(join(configDir, "opencode", "docs")), "no workspace docs under the config dir");
    assert.ok(!existsSync(join(configDir, "opencode", "skills")), "skills are store-provisioned, never config-dir files");
    assert.ok(!existsSync(join(configDir, "opencode", "config.jsonc")), "the permission surface is never written");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("the installed agent model pins are metered-id-prefixed and resolve, without editing the vendored source", () => {
  const configDir = mkdtempSync(join(tmpdir(), "wf-fleet-model-"));
  try {
    installFleetIntoOpencodeConfig(configDir);
    const manifest = loadFleetManifest();
    const agents = manifest.entries.filter((entry) => entry.kind === "agent");
    assert.ok(agents.length >= 4);
    for (const entry of agents) {
      const installed = readFileSync(join(configDir, "opencode", "agents", entry.file), "utf8");
      const match = /^model:\s*(\S.*)$/m.exec(installed);
      assert.ok(match !== null, `${entry.id} carries a model pin`);
      const ref = match![1]!;
      const slash = ref.indexOf("/");
      assert.equal(ref.slice(0, slash), OPENCODE_V2_METERED_PROVIDER_ID, `${entry.id} pin rides the registered metered provider`);
      assert.ok(FLEET_TIER_MODEL_IDS.includes(ref.slice(slash + 1)), `${entry.id} pin names a composed tier id`);
      assert.ok(!installed.includes("synthetic/"), `${entry.id} no longer names the unregistered synthetic provider`);
      // The ACP v2 picker translation leaves the metered ref unchanged (it is
      // not a vendor built-in), so the pinned session model resolves.
      assert.equal(v2BuiltinModelRef(ref), ref, `${entry.id} pin survives the v2 picker translation`);
    }
    // The vendored SOURCE is untouched: its bytes still hash to the manifest.
    for (const entry of agents) {
      const source = readFileSync(join(fleetAssetsRoot(), "agents", entry.file));
      assert.equal(sha256(source), entry.sha256, `${entry.id} vendored source is byte-identical to the manifest`);
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("the doctor's compare agrees with a runtime-lane install under the same transform (no false differs)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "wf-fleet-compare-"));
  try {
    installFleetIntoOpencodeConfig(configDir);
    // Compare against the EXACT installer transform, so the doctor-agreement
    // claim is against the real runtime-lane payload (agent rewrite + the
    // AGENTS.md ambient fold), not a hand-rolled subset.
    const statuses = compareFleet({
      configDir: join(configDir, "opencode"),
      kinds: RUNTIME_FLEET_KINDS,
      transform: runtimeFleetTransform(),
    });
    const states = new Set(statuses.map((status) => status.state));
    assert.deepEqual([...states], ["current"], `every runtime-lane entry is current, got ${JSON.stringify([...states])}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

// ── fleet skills are store-provisioned, ambient docs folded into AGENTS.md ──

test("provisionFleetSkills writes the vendored code-cheatsheet skill into the store, idempotently", () => {
  const skillsDir = mkdtempSync(join(tmpdir(), "wf-fleet-skills-"));
  try {
    const written = provisionFleetSkills(skillsDir);
    assert.ok(written.some((path) => path.endsWith(join("code-cheatsheet", "SKILL.md"))), "SKILL.md is provisioned");
    assert.ok(written.some((path) => path.endsWith(join("code-cheatsheet", "template.md"))), "every skill asset is provisioned");
    const manifest = loadFleetManifest();
    const skills = manifest.entries.filter((entry) => entry.kind === "skill");
    for (const entry of skills) {
      assert.equal(
        readFileSync(join(skillsDir, entry.file)).toString("utf8"),
        readFileSync(join(fleetAssetsRoot(), "skills", entry.file)).toString("utf8"),
        `${entry.id} is byte-identical to the vendored asset`,
      );
    }
    // No churn on a second run (byte-compare).
    assert.deepEqual(provisionFleetSkills(skillsDir), []);
  } finally {
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test("foldFleetAmbientDocs appends the docs in order under banners, and is a no-op with none", () => {
  const base = Buffer.from("# AGENTS\nroot content\n");
  const folded = foldFleetAmbientDocs(base, [
    { label: "STANDARDS.md", payload: Buffer.from("# STANDARDS\nstandards body\n") },
    { label: "style/coding-style.md", payload: Buffer.from("# Style\nstyle body\n") },
  ]).toString("utf8");
  assert.ok(folded.startsWith(base.toString("utf8")), "the AGENTS.md content stays at the top");
  const standardsAt = folded.indexOf("standards body");
  const styleAt = folded.indexOf("style body");
  assert.ok(standardsAt > -1 && styleAt > -1, "both folded docs appear");
  assert.ok(standardsAt < styleAt, "STANDARDS precedes the style floor");
  assert.ok(folded.includes("fleet:STANDARDS.md"), "the Standards banner is present");
  assert.ok(folded.includes("fleet:style/coding-style.md"), "the style banner is present");
  // Deterministic: the same inputs produce the same bytes.
  const again = foldFleetAmbientDocs(base, [
    { label: "STANDARDS.md", payload: Buffer.from("# STANDARDS\nstandards body\n") },
    { label: "style/coding-style.md", payload: Buffer.from("# Style\nstyle body\n") },
  ]).toString("utf8");
  assert.equal(folded, again);
  // No ambient docs => byte-identical passthrough.
  assert.equal(foldFleetAmbientDocs(base, []).toString("utf8"), base.toString("utf8"));
});

test("the runtime-lane install folds STANDARDS.md and coding-style.md into the installed global AGENTS.md", () => {
  const configDir = mkdtempSync(join(tmpdir(), "wf-fleet-instr-"));
  try {
    installFleetIntoOpencodeConfig(configDir);
    const agentsMd = readFileSync(join(configDir, "opencode", "AGENTS.md"), "utf8");
    const standards = readFileSync(join(fleetAssetsRoot(), "instructions", "STANDARDS.md"), "utf8").replace(/\n+$/, "");
    const style = readFileSync(join(fleetAssetsRoot(), "style", "coding-style.md"), "utf8").replace(/\n+$/, "");
    assert.ok(agentsMd.includes(standards), "STANDARDS.md content is folded into AGENTS.md");
    assert.ok(agentsMd.includes(style), "coding-style.md content is folded into AGENTS.md");
    // The source docs still install as their own files (the CLI lane and the
    // manifest expect them; only v2 delivery rides AGENTS.md).
    assert.ok(existsSync(join(configDir, "opencode", "STANDARDS.md")), "STANDARDS.md installs as its own file");
    assert.ok(existsSync(join(configDir, "opencode", "style", "coding-style.md")), "coding-style.md installs as its own file");
    // Idempotent install: a second run reports already-current (stable hash).
    const second = installFleetIntoOpencodeConfig(configDir);
    assert.ok(second.every((result) => result.action === "already-current"), "the folded AGENTS.md hashes stably");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

// ── the composed tier catalog ───────────────────────────────────────────────

test("meteredOpencodeConfig composes the fleet tier ids only when opted in (v1 custom provider)", () => {
  const off = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999" });
  const offProvider = (off.provider as Record<string, { models: Record<string, unknown> }>)[OPENCODE_METERED_PROVIDER_ID]!;
  for (const id of FLEET_TIER_MODEL_IDS) assert.equal(offProvider.models[id], undefined, `${id} is absent without the opt-in`);

  const on = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", fleetModelTiers: true });
  const onProvider = (on.provider as Record<string, { models: Record<string, unknown> }>)[OPENCODE_METERED_PROVIDER_ID]!;
  for (const id of FLEET_TIER_MODEL_IDS) assert.ok(onProvider.models[id] !== undefined, `${id} is a selectable model with the opt-in`);
  assert.ok(onProvider.models["openrouter/auto"] !== undefined, "the Auto Router default is preserved");
});

test("meteredOpencodeConfig composes the fleet tier ids into the v2 built-in catalog only when opted in", () => {
  const off = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", opencodeMajor: 2 });
  const offProvider = (off.providers as Record<string, { models?: Record<string, unknown> }>)[OPENCODE_V2_METERED_PROVIDER_ID]!;
  assert.equal(offProvider.models, undefined, "no models key without the opt-in (byte-identical)");

  const on = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", opencodeMajor: 2, fleetModelTiers: true });
  const onProvider = (on.providers as Record<string, { models?: Record<string, unknown> }>)[OPENCODE_V2_METERED_PROVIDER_ID]!;
  for (const id of FLEET_TIER_MODEL_IDS) assert.ok(onProvider.models?.[id] !== undefined, `${id} is in the v2 built-in catalog`);
  assert.ok(!JSON.stringify(on).includes("workflow-metered"), "the v2 config stays credential-free");
});
