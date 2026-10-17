import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { CARE_ASSERTION_RULE, createCareFacts, readCareProjection, type CareFact } from "../src/integrations/care-facts.js";
import { readCarePolicy } from "../src/integrations/care-policy.js";

// W213 — the care fact store (decision-brief Decision 2, Option C) and the
// Q28 policy seam. Pins the contract:
//   - the curated core (core.yaml) and the inert annotation channel
//     (annotations.json) parse independently and stay SEPARATE.
//   - assertion/gate read the core ONLY: an annotation with the same key is
//     never returned (the curated-core-only rule, enforced in code).
//   - gate grounds present keys in input order, DROPS absent keys (fail
//     closed), and collapses duplicates.
//   - a MISSING core/annotations/policy file is the honest empty channel /
//     "unset" policy; a MALFORMED (present-but-invalid) file THROWS — never
//     silently empty, never an invented fact.
//   - the facts/annotations caps bound the channels in document order.

const seat = (context: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "wf-care-facts-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const CORE_YAML = [
  "facts:",
  "  - key: resident-name",
  "    value: Margaret Ellis",
  "    category: person",
  "    note: prefers \"Maggie\"",
  "  - key: morning-medication",
  "    value: donepezil 10mg at 08:00",
  "    category: medication",
  "  - key: daughter-visit",
  "    value: Sundays after lunch",
  "    category: schedule",
  "",
].join("\n");

const ANNOTATIONS_JSON = JSON.stringify({
  annotations: [
    { key: "resident-name", value: "Margaret Smith", observedAt: "2026-10-17T09:00:00.000Z", source: "care-turn", note: "self-reported surname differs" },
    { key: "teacup-count", value: "3", observedAt: "2026-10-17T10:00:00.000Z", source: "care-turn" },
  ],
});

const writeCore = (dir: string, content: string = CORE_YAML): void => {
  writeFileSync(join(dir, "core.yaml"), content);
};

test("W213: the curated core parses from core.yaml (note optional, category typed)", (context) => {
  const dir = seat(context);
  writeCore(dir);
  const store = createCareFacts({ dir });
  assert.equal(store.dir, dir);
  assert.equal(store.facts().length, 3);
  const first = store.facts()[0] as CareFact;
  assert.deepEqual(first, {
    key: "resident-name",
    value: "Margaret Ellis",
    category: "person",
    note: "prefers \"Maggie\"",
  });
  const facts = store.facts();
  assert.equal(facts[1]?.note, undefined, "note is optional — absent, never fabricated");
});

test("W213: the annotation channel parses from annotations.json, beside and separate from the core", (context) => {
  const dir = seat(context);
  writeCore(dir);
  writeFileSync(join(dir, "annotations.json"), ANNOTATIONS_JSON);
  const store = createCareFacts({ dir });
  assert.equal(store.annotations().length, 2);
  assert.equal(store.facts().length, 3, "annotations never enlarge the core");
  const annotation = store.annotations()[0];
  assert.equal(annotation?.source, "care-turn");
});

test("W213: assertion reads the core ONLY — an annotation with the same key is never returned", (context) => {
  const dir = seat(context);
  writeCore(dir);
  writeFileSync(join(dir, "annotations.json"), ANNOTATIONS_JSON);
  const store = createCareFacts({ dir });
  assert.deepEqual(store.assertion("resident-name"), { present: true, value: "Margaret Ellis" }, "the core value wins; the annotation never overrides");
  assert.deepEqual(store.assertion("teacup-count"), { present: false }, "an annotation-only key is never asserted");
  assert.deepEqual(store.assertion("nonexistent"), { present: false });
});

test("W213: gate grounds present keys in input order, drops absent keys (fail closed), collapses duplicates", (context) => {
  const dir = seat(context);
  writeCore(dir);
  writeFileSync(join(dir, "annotations.json"), ANNOTATIONS_JSON);
  const store = createCareFacts({ dir });
  const verdict = store.gate(["imaginary", "morning-medication", "resident-name", "imaginary", "morning-medication", "teacup-count"]);
  assert.deepEqual(verdict.grounded, [
    { key: "morning-medication", value: "donepezil 10mg at 08:00" },
    { key: "resident-name", value: "Margaret Ellis" },
  ], "grounded preserves first-occurrence input order and dedupes");
  assert.deepEqual(verdict.dropped, ["imaginary", "teacup-count"], "absent keys drop (fail closed); annotation-only keys drop too; duplicates collapse");
  assert.deepEqual(store.gate([]), { grounded: [], dropped: [] });
});

test("W213: a duplicate core key resolves first-wins in document order", (context) => {
  const dir = seat(context);
  writeCore(dir, ["facts:", "  - key: dup", "    value: first", "    category: other", "  - key: dup", "    value: second", "    category: other", ""].join("\n"));
  const store = createCareFacts({ dir });
  assert.deepEqual(store.assertion("dup"), { present: true, value: "first" });
});

test("W213: a missing dir or missing files are honest absences — the empty core, the empty channel", (context) => {
  const dir = seat(context);
  const empty = createCareFacts({ dir });
  assert.deepEqual(empty.facts(), []);
  assert.deepEqual(empty.annotations(), []);
  assert.deepEqual(empty.assertion("anything"), { present: false });
  const absent = createCareFacts({ dir: join(dir, "does-not-exist") });
  assert.deepEqual(absent.facts(), []);
  assert.deepEqual(absent.annotations(), []);
});

test("W213: a malformed core THROWS — present-but-invalid never reads as silently empty", (context) => {
  const dir = seat(context);
  writeFileSync(join(dir, "core.yaml"), "facts: [unclosed");
  assert.throws(() => createCareFacts({ dir }), /invalid care core/, "unparseable YAML is an honest error surface");
  const dir2 = join(dir, "schema-broken");
  mkdirSync(dir2);
  writeFileSync(join(dir2, "core.yaml"), "facts:\n  - value: missing its key\n    category: person\n");
  assert.throws(() => createCareFacts({ dir: dir2 }), /invalid care core/, "a schema-invalid fact is an honest error surface");
  const dir3 = join(dir, "bad-category");
  mkdirSync(dir3);
  writeFileSync(join(dir3, "core.yaml"), "facts:\n  - key: k\n    value: v\n    category: bogus\n");
  assert.throws(() => createCareFacts({ dir: dir3 }), /invalid care core/, "an out-of-enum category is refused");
});

test("W213: a malformed annotations file THROWS — the inert channel never fabricates either", (context) => {
  const dir = seat(context);
  writeCore(dir);
  writeFileSync(join(dir, "annotations.json"), "{not json");
  assert.throws(() => createCareFacts({ dir }), /invalid care annotations/);
  const dir2 = join(dir, "shape-broken");
  mkdirSync(dir2);
  writeFileSync(join(dir2, "annotations.json"), JSON.stringify({ annotations: [{ key: "k" }] }));
  assert.throws(() => createCareFacts({ dir: dir2 }), /invalid care annotations/, "an annotation without value/observedAt/source is refused");
});

test("W213: the facts and annotations caps bound the channels in document order", (context) => {
  const dir = seat(context);
  const factLines = ["facts:"];
  for (let index = 0; index < 7; index += 1) {
    factLines.push("  - key: fact-" + index, "    value: v" + index, "    category: other");
  }
  writeFileSync(join(dir, "core.yaml"), factLines.join("\n") + "\n");
  const annotations = [];
  for (let index = 0; index < 6; index += 1) {
    annotations.push({ key: "a-" + index, value: "v", observedAt: "2026-10-17T00:00:00.000Z", source: "care-turn" });
  }
  writeFileSync(join(dir, "annotations.json"), JSON.stringify({ annotations }));
  const store = createCareFacts({ dir, maxFacts: 3, maxAnnotations: 4 });
  assert.equal(store.facts().length, 3);
  assert.deepEqual(store.facts().map((fact) => fact.key), ["fact-0", "fact-1", "fact-2"], "first-N, document order");
  assert.equal(store.annotations().length, 4);
  assert.throws(() => createCareFacts({ dir, maxFacts: 0 }), /maxFacts must be a positive integer/);
});

test("W213: the Q28 policy seam — unset by default, a set value reads honestly, malformed throws", (context) => {
  const dir = seat(context);
  assert.deepEqual(readCarePolicy(dir), { realityOrientation: "unset" }, "a missing policy file is the honest unset seam");
  writeFileSync(join(dir, "policy.yaml"), "realityOrientation: orient_gently\n");
  assert.deepEqual(readCarePolicy(dir), { realityOrientation: "orient_gently" }, "a set value reads verbatim — never a chosen default");
  const dir2 = join(dir, "broken");
  mkdirSync(dir2);
  writeFileSync(join(dir2, "policy.yaml"), "realityOrientation: invent_the_truth\n");
  assert.throws(() => readCarePolicy(dir2), /invalid care policy/, "an out-of-enum value is refused, not defaulted");
});

test("W213: the projection keeps the channels separate and carries the static versioned rule", (context) => {
  const dir = seat(context);
  writeCore(dir);
  writeFileSync(join(dir, "annotations.json"), ANNOTATIONS_JSON);
  const projection = readCareProjection(dir);
  assert.equal(projection.root, dir);
  assert.equal(projection.facts.length, 3);
  assert.equal(projection.annotations.length, 2);
  assert.equal(projection.realityOrientation, "unset", "no policy file -> the honest unset seam");
  assert.equal(projection.rule, CARE_ASSERTION_RULE);
  assert.match(projection.rule, /^curated-core-only\/v1:/, "the rule is a versioned constant");
  assert.ok(
    projection.facts.every((fact) => !("observedAt" in fact)) && projection.annotations.every((annotation) => "observedAt" in annotation),
    "facts and annotations stay distinguishable on the wire",
  );
});
