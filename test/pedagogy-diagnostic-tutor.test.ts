import assert from "node:assert/strict";
import test from "node:test";

import { createDiagnosticLesson } from "../src/index.js";

test("creates high-scaffolding beginner lesson in learn-to-code mode", () => {
  const lesson = createDiagnosticLesson(
    {
      code: 2322,
      message: "Type 'number' is not assignable to type 'string'.",
      file: "src/app.ts",
      line: 12,
      column: 5,
    },
    "learn-to-code",
  );

  assert.equal(lesson.code, 2322);
  assert.equal(lesson.mode, "learn-to-code");
  assert.equal(lesson.file, "src/app.ts");
  assert.equal(lesson.line, 12);
  assert.equal(lesson.column, 5);
  assert.ok(lesson.plainEnglishExplanation.includes("does not fit the type"));
  assert.ok(lesson.guidingHints.some((hint) => hint.includes("conversion function")));
});

test("creates conceptual Socratic lesson in socratic-tutor mode", () => {
  const lesson = createDiagnosticLesson(
    {
      code: 2345,
      message: "Argument of type 'null' is not assignable to parameter of type 'string'.",
      file: "src/service.ts",
      line: 45,
      column: 18,
    },
    "socratic-tutor",
  );

  assert.equal(lesson.code, 2345);
  assert.equal(lesson.mode, "socratic-tutor");
  assert.ok(lesson.plainEnglishExplanation.includes("argument type violates"));
  assert.ok(lesson.underlyingPrinciple.includes("preconditions"));
  assert.ok(lesson.guidingHints.some((hint) => hint.includes("narrowing")));
});

test("creates null safety lesson with optional chaining guidance", () => {
  const lesson = createDiagnosticLesson(
    {
      code: 2531,
      message: "Object is possibly 'null'.",
      file: "src/user.ts",
      line: 8,
      column: 10,
    },
    "learn-to-code",
  );

  assert.equal(lesson.code, 2531);
  assert.ok(lesson.plainEnglishExplanation.includes("might be empty"));
  assert.ok(lesson.guidingHints.some((hint) => hint.includes("optional chaining (?.)")));
});

test("falls back cleanly on unrecognized diagnostic code", () => {
  const lesson = createDiagnosticLesson(
    {
      code: 99999,
      message: "Unusual compiler warning",
      file: "src/test.ts",
      line: 1,
      column: 1,
    },
    "autonomous",
  );

  assert.equal(lesson.code, 99999);
  assert.ok(lesson.plainEnglishExplanation.includes("Unusual compiler warning"));
  assert.ok(lesson.underlyingPrinciple.includes("Static analysis"));
});
