import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIMM_STAGES,
  fillInTheGap,
  primmScaffold,
} from "../src/pedagogy/primm.js";

test("primmScaffold returns one prompt per PRIMM stage in order", () => {
  const scaffold = primmScaffold({
    snippet: "const total = prices.reduce((sum, p) => sum + p, 0);",
    goal: "compute a running total",
    concept: "reduce",
  });

  assert.deepEqual(scaffold.map((entry) => entry.stage), [...PRIMM_STAGES]);
  assert.equal(scaffold.length, 5);
  for (const entry of scaffold) {
    assert.ok(entry.title.length > 0);
    assert.ok(entry.prompt.length > 0);
  }
});

test("primmScaffold embeds the snippet and goal deterministically", () => {
  const input = {
    snippet: "for (const n of nums) console.log(n * 2);",
    goal: "print doubled numbers",
    concept: "iteration",
  };
  const first = primmScaffold(input);
  const second = primmScaffold(input);

  assert.deepEqual(first, second);
  const predict = first[0]?.prompt ?? "";
  assert.ok(predict.includes(input.snippet));
  assert.ok(predict.includes(input.goal));
  // Predict precedes Run: predict must not reveal the answer.
  assert.match(predict.toLowerCase(), /predict/);
  assert.match((first[1]?.prompt ?? "").toLowerCase(), /run/);
  assert.match((first[2]?.prompt ?? "").toLowerCase(), /investigate|trace|line/);
  assert.match((first[3]?.prompt ?? "").toLowerCase(), /modify|change/);
  assert.match((first[4]?.prompt ?? "").toLowerCase(), /make|own/);
});

test("fillInTheGap masks target substrings with numbered blanks", () => {
  const template = fillInTheGap({
    snippet: "const double = (n) => n * 2;",
    targets: ["n * 2"],
  });

  assert.equal(template.masked, "const double = (n) => ___1___;");
  assert.deepEqual(template.blanks, [{ placeholder: "___1___", answer: "n * 2" }]);
});

test("fillInTheGap masks every occurrence and numbers blanks left to right", () => {
  const template = fillInTheGap({
    snippet: "log(a); log(b);",
    targets: ["log"],
  });

  assert.equal(template.masked, "___1___(a); ___2___(b);");
  assert.deepEqual(template.blanks, [
    { placeholder: "___1___", answer: "log" },
    { placeholder: "___2___", answer: "log" },
  ]);
});

test("fillInTheGap masks multiple distinct targets longest-first", () => {
  const template = fillInTheGap({
    snippet: "const add = (a, b) => a + b;",
    targets: ["a + b", "a, b"],
  });

  assert.equal(template.masked, "const add = (___1___) => ___2___;");
  assert.deepEqual(template.blanks, [
    { placeholder: "___1___", answer: "a, b" },
    { placeholder: "___2___", answer: "a + b" },
  ]);
});

test("fillInTheGap rejects targets that are absent or blank", () => {
  assert.throws(
    () => fillInTheGap({ snippet: "const x = 1;", targets: ["missing"] }),
    /not found/i,
  );
  assert.throws(
    () => fillInTheGap({ snippet: "const x = 1;", targets: [""] }),
    /empty/i,
  );
});

test("fillInTheGap is deterministic and does not mutate its input", () => {
  const input = { snippet: "return value;", targets: ["value"] as const };
  const first = fillInTheGap(input);
  const second = fillInTheGap(input);

  assert.deepEqual(first, second);
  assert.equal(input.snippet, "return value;");
});
