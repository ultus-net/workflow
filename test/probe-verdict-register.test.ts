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
 * suite, so the register cannot quietly rot. Every row's free-text `evidence`
 * is pinned the same way: `loadProbeVerdicts` resolves each repo-relative path
 * it cites (including the `acp-remote-sse-idle` row's
 * `docs/HOST_ADAPTERS.md` idle-window citation) and throws when one is gone,
 * so a verdict cannot outlive the write-up that earned it. The
 * `acp-remote-sse-idle` row's `green` is not read at all: the register
 * re-derives the survival from the idle-hold facts the row carries, through
 * the same `classifySseIdleHold` the gated arm decides with, so a hand-edited
 * green cannot outlive the measurement that earned it.
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
  // The cited write-up is pinned as hard as the executable gate: an `evidence`
  // string naming a doc/test that is gone fails closed, so a verdict cannot
  // outlive the write-up that earned it.
  assert.throws(() => validateProbeVerdictRegister({
    ...base,
    verdicts: [{ ...base.verdicts[0]!, evidence: "docs/HOST_ADAPTERS.md row; docs/nowhere.md" }],
  }, { exists: (path) => !path.endsWith("nowhere.md") }), /cited evidence not found: docs\/nowhere\.md/);
  // Sentence punctuation is not part of the path, and a version string or an
  // API route in the prose is not a citation: only the named path is resolved.
  assert.equal(validateProbeVerdictRegister({
    ...base,
    verdicts: [{
      ...base.verdicts[0]!,
      evidence: "Live run on 2.0.10: /api/event is an observable SSE stream, matrix pinned in test/opencode-v2-route-class.test.ts.",
    }],
  }, { exists: (path) => path.endsWith("test/a-probe.test.ts") || path.endsWith("test/opencode-v2-route-class.test.ts") }).verdicts.length, 1);
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

test("the idle-hold gate's green is re-derived from the row's own facts, not trusted", () => {
  const exists = () => true;
  /** The facts a clean 240s no-event hold records. */
  const cleanHold = { heldMs: 240_000, idleWindowMs: 240_000, delivered: 0, subscriptions: 1, openedBefore: 1 };
  const idleRow = {
    id: "acp-remote-sse-idle",
    host: "opencode (remote/attached server)",
    hostVersion: "2.0.10",
    probe: "test/acp-remote-sse-probe.test.ts",
    gate: "WORKFLOW_ACP_REMOTE_SSE_IDLE",
    date: "2026-09-27",
    result: "green",
    posture: "advisory",
    evidence: "docs/HOST_ADAPTERS.md remote ACP bridge entry",
  };
  const register = (verdicts: readonly unknown[]): unknown => ({ version: 1, updated: "2026-09-27", verdicts });

  // A green backed by a clean hold stands: the register checks the facts, it
  // does not refuse a survival the measurement supports.
  assert.equal(validateProbeVerdictRegister(register([{ ...idleRow, idleHold: cleanHold }]), { exists }).verdicts.length, 1);

  // No facts at all: a survival with nothing measured behind it is drift, not
  // a pass — the register's other answer to a claim nothing backs.
  assert.throws(() => validateProbeVerdictRegister(register([idleRow]), { exists }), /must record the idleHold facts/);

  // Facts that deny the survival the row claims: every failing outcome the
  // shared classifier can reach is refused, in the arm's own wording.
  const contradicting: readonly (readonly [string, Record<string, unknown>])[] = [
    ["dropped", { ...cleanHold, drop: "the event stream ended" }],
    ["resumed", { ...cleanHold, subscriptions: 2 }],
    ["never-opened", { ...cleanHold, subscriptions: 0, openedBefore: 0 }],
    ["short-hold", { ...cleanHold, heldMs: 90_000 }],
  ];
  for (const [outcome, idleHold] of contradicting) {
    assert.throws(
      () => validateProbeVerdictRegister(register([{ ...idleRow, idleHold }]), { exists }),
      new RegExp(`green contradicts its own idleHold facts: classifySseIdleHold reads this hold as '${outcome}'`),
      `a green whose own facts classify as '${outcome}' must fail closed`,
    );
  }

  // Facts present on a non-green row are still typed and still measured: a
  // `pending` row has not run and needs no hold, but a row that carries facts
  // must carry measurable ones.
  assert.equal(
    validateProbeVerdictRegister(register([{ ...idleRow, result: "pending", posture: "unqualified" }]), { exists }).verdicts.length,
    1,
  );
  assert.throws(
    () => validateProbeVerdictRegister(register([{ ...idleRow, result: "red", posture: "advisory", idleHold: "a hold happened" }]), { exists }),
    /idleHold must be the facts object/,
  );
  assert.throws(
    () => validateProbeVerdictRegister(register([{ ...idleRow, result: "red", posture: "advisory", idleHold: { ...cleanHold, heldMs: -1 } }]), { exists }),
    /idleHold facts are not a measurable hold/,
  );
  // A `red` idle row may record the facts that say why: only a survival claim
  // is re-derived against a pass condition.
  assert.equal(
    validateProbeVerdictRegister(register([{ ...idleRow, result: "red", posture: "advisory", idleHold: { ...cleanHold, drop: "the event stream ended" } }]), { exists }).verdicts.length,
    1,
  );

  // The shipped row stays honestly unmeasured: pending, with no facts invented
  // for a window that has never been held live.
  const shipped = loadProbeVerdicts({ root: ROOT }).verdicts.find((verdict) => verdict.id === "acp-remote-sse-idle");
  assert.equal(shipped?.result, "pending");
  assert.equal(shipped?.idleHold, undefined, "a pending row has no hold facts to record");
});

test("doctor: the register check renders counts, armed gates, and honest open states", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wf-probe-register-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "fixture-probe.test.ts"), 'const gated = process.env.WORKFLOW_TEST_FAKE === "1";');
  writeFileSync(join(root, "docs", "FIXTURE_EVIDENCE.md"), "# fixture write-up\n");
  const verdictRow = {
    id: "fixture",
    host: "fixture",
    hostVersion: "1",
    probe: "test/fixture-probe.test.ts",
    gate: "WORKFLOW_TEST_FAKE",
    date: "2026-09-20",
    result: "pending",
    posture: "unqualified",
    evidence: "docs/FIXTURE_EVIDENCE.md fixture row",
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

  // A row citing a write-up that is gone fails closed, with the fix naming the
  // citation requirement.
  writeProbeRegister(root, {
    version: 1,
    updated: "2026-09-20",
    verdicts: [{ ...verdictRow, result: "green", blocker: undefined, evidence: "docs/deleted-writeup.md" }],
  });
  const dangling = checkProbeVerdicts({ root });
  assert.equal(dangling.status, "fail");
  assert.match(dangling.detail, /cited evidence not found: docs\/deleted-writeup\.md/);
  assert.match(dangling.fix ?? "", /cited evidence must exist/);

  writeFileSync(join(root, "docs", "PROBE_VERDICTS.json"), "{not json");
  const corrupt = checkProbeVerdicts({ root });
  assert.equal(corrupt.status, "fail");
  assert.match(corrupt.detail, /failed validation \(fail-closed\)/);
  assert.match(corrupt.fix ?? "", /repair docs\/PROBE_VERDICTS\.json/);
});

function writeProbeRegister(root: string, register: unknown): void {
  writeFileSync(probeVerdictsPath(root), JSON.stringify(register, null, 2));
}