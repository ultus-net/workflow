import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  loadProbeVerdicts,
  probeVerdictsPath,
  validateProbeVerdictRegister,
} from "../src/integrations/probe-verdicts.js";
import { checkProbeVerdicts } from "../src/cli/doctor.js";

/**
 * W078 follow-up — the machine-readable probe verdict register
 * (`docs/PROBE_VERDICTS.json`): the durable record that keeps documentation
 * and runtime claims from drifting. The load-bearing pin is bidirectional
 * anti-drift against the REAL test corpus: every register row's probe file
 * must exist and name its gate, and every gate-style probe file in the test
 * corpus must have a register row — adding a gated probe without registering
 * it (or renaming/removing a gate the register still records) fails this
 * suite, so the register cannot quietly rot.
 */

/** Repo root: one level up from this test file's directory. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "test");

/** Every gate-style env check in the test corpus: file → set of gates.
 * This file is excluded: it writes fixture gate literals (never real gates),
 * so its own text must not be mistaken for an unregistered probe.
 *
 * Known heuristic limits, documented so future probe authors do not silently
 * dodge the pin: the scan is a flat (non-recursive) readdir of `test/` and
 * matches only the literal `WORKFLOW_X === "1"` comparison — bracket access
 * (`process.env["WORKFLOW_X"]`), `.trim() === "1"`, or helper-mediated gates
 * are invisible to it. No such pattern exists in the corpus today; if one
 * lands, extend the scan rather than trusting it to be caught. */
function corpusGates(): Map<string, Set<string>> {
  const gates = new Map<string, Set<string>>();
  for (const file of readdirSync(TEST_DIR)) {
    if (!file.endsWith(".test.ts") || file === "probe-verdict-register.test.ts") continue;
    const source = readFileSync(join(TEST_DIR, file), "utf8");
    const found = new Set<string>();
    for (const match of source.matchAll(/(WORKFLOW_[A-Z0-9_]+)\s*===\s*"1"/g)) {
      found.add(match[1]!);
    }
    if (found.size > 0) gates.set(file, found);
  }
  return gates;
}

test("the shipped probe verdict register parses fail-closed and is well-formed", () => {
  const register = loadProbeVerdicts({ root: ROOT });
  assert.equal(register.version, 1);
  assert.match(register.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(register.verdicts.length > 0);
  const ids = new Set(register.verdicts.map((verdict) => verdict.id));
  assert.equal(ids.size, register.verdicts.length, "register ids must be unique");
  for (const verdict of register.verdicts) {
    assert.match(verdict.probe, /^test\/[A-Za-z0-9._-]+\.test\.ts$/);
    assert.match(verdict.gate, /^WORKFLOW_[A-Z0-9_]+$/);
    assert.match(verdict.date, /^\d{4}-\d{2}-\d{2}$/);
    if (verdict.result === "blocked") {
      assert.ok(verdict.blocker !== undefined && verdict.blocker.trim().length > 0, `${verdict.id}: blocked needs its blocker`);
    }
    assert.ok(verdict.evidence.trim().length > 0, `${verdict.id}: every verdict points at a real write-up`);
  }
});

test("anti-drift: every registered probe file exists and names its gate", () => {
  const register = loadProbeVerdicts({ root: ROOT });
  for (const verdict of register.verdicts) {
    const source = readFileSync(join(ROOT, verdict.probe), "utf8");
    assert.ok(
      source.includes(verdict.gate),
      `${verdict.id}: probe file ${verdict.probe} no longer names its gate ${verdict.gate} — update the register row or fix the probe`,
    );
  }
});

test("anti-drift: every gate-style probe file in the corpus is registered", () => {
  const register = loadProbeVerdicts({ root: ROOT });
  const registered = new Map<string, Set<string>>();
  for (const verdict of register.verdicts) {
    const file = verdict.probe.replace(/^test\//, "");
    const set = registered.get(file) ?? new Set<string>();
    set.add(verdict.gate);
    registered.set(file, set);
  }
  for (const [file, gates] of corpusGates()) {
    const covered = registered.get(file) ?? new Set<string>();
    for (const gate of gates) {
      assert.ok(
        covered.has(gate),
        `gate ${gate} in test/${file} has no probe-verdict register row — record the dated verdict in docs/PROBE_VERDICTS.json`,
      );
    }
  }
});

test("register validation fails closed on schema drift", () => {
  const exists = () => true;
  const base = {
    version: 1,
    updated: "2026-09-20",
    verdicts: [{
      id: "x",
      host: "opencode",
      hostVersion: "2.0.10",
      probe: "test/a-probe.test.ts",
      gate: "WORKFLOW_A_PROBE",
      date: "2026-09-20",
      result: "green",
      posture: "advisory",
      evidence: "docs/HOST_ADAPTERS.md",
    }],
  };
  assert.equal(validateProbeVerdictRegister(structuredClone(base), { exists }).verdicts.length, 1);

  assert.throws(() => validateProbeVerdictRegister({ ...base, version: 2 }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({ ...base, updated: "2026-09" }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({ ...base, verdicts: [] }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, id: "" }],
  }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [base.verdicts[0], { ...base.verdicts[0]!, id: "x" }],
  }, { exists }), /duplicate id/);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, gate: "NOT_A_GATE" }],
  }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, result: "banana" }],
  }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, posture: "banana" }],
  }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, date: "yesterday" }],
  }, { exists }), TypeError);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, result: "blocked" }],
  }, { exists }), /blocked verdict must name its blocker/);
  assert.throws(
    () => validateProbeVerdictRegister(structuredClone(base), { exists: () => false }),
    /probe file not found/,
    "a register row pointing at a deleted probe is drift, not a stale claim",
  );
  // Optional fields are typed too: a non-string blocker/note is drift.
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, note: 42 }],
  }, { exists }), /note must be a non-empty string/);
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, result: "pending", blocker: 42 }],
  }, { exists }), /blocker must be a non-empty string/);
  // Subdirectory probe paths are registrable (the scan stays flat today, but
  // the schema must not forbid a gated probe living under test/<dir>/).
  assert.equal(validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, probe: "test/integration/a-probe.test.ts" }],
  }, { exists }).verdicts.length, 1);
  // Dated honesty: the register stamp can never predate its newest verdict.
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    updated: "2026-09-19",
  }, { exists }), /predates the newest verdict date/);
});

test("doctor: the register check renders counts, armed gates, and honest open states", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wf-probe-register-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "fixture-probe.test.ts"), 'const gated = process.env.WORKFLOW_TEST_FAKE === "1";');
  const verdictRow = {
    id: "fixture",
    host: "fixture",
    hostVersion: "1",
    probe: "test/fixture-probe.test.ts",
    gate: "WORKFLOW_TEST_FAKE",
    date: "2026-09-20",
    result: "pending",
    posture: "unqualified",
    evidence: "docs/nowhere.md",
    blocker: "no fixture credentials",
  };
  writeProbeRegister(root, { version: 1, updated: "2026-09-20", verdicts: [verdictRow] });

  const previous = process.env.WORKFLOW_TEST_FAKE;
  process.env.WORKFLOW_TEST_FAKE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_TEST_FAKE;
    else process.env.WORKFLOW_TEST_FAKE = previous;
  });

  const check = checkProbeVerdicts({ root });
  assert.equal(check.status, "warn", "pending/blocked are honest open states, surfaced as a warn");
  assert.match(check.detail, /1 verdicts — 0 green, 0 red, 0 negative, 1 pending, 0 blocked/);
  assert.match(check.detail, /WORKFLOW_TEST_FAKE/, "the armed gate is named");
  assert.match(check.fix ?? "", /WORKFLOW_<GATE>=1/);
  assert.match(check.fix ?? "", /fixture/);

  // A fully decided register passes; a corrupt one fails with the fix.
  writeProbeRegister(root, {
    version: 1,
    updated: "2026-09-20",
    verdicts: [{ ...verdictRow, result: "green", blocker: undefined }],
  });
  const decided = checkProbeVerdicts({ root });
  assert.equal(decided.status, "pass");
  assert.equal(decided.fix, undefined);

  writeFileSync(join(root, "docs", "PROBE_VERDICTS.json"), "{not json");
  const corrupt = checkProbeVerdicts({ root });
  assert.equal(corrupt.status, "fail");
  assert.match(corrupt.detail, /failed validation \(fail-closed\)/);
  assert.match(corrupt.fix ?? "", /repair docs\/PROBE_VERDICTS\.json/);
});

function writeProbeRegister(root: string, register: unknown): void {
  writeFileSync(probeVerdictsPath(root), JSON.stringify(register, null, 2));
}