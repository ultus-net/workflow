import assert from "node:assert/strict";
import test from "node:test";

import { StylePackSchema, buildSystemPrompt, loadStyle } from "../src/assistant/style/pack.js";
import { lint } from "../src/assistant/lint.js";

// W211: the diagram FORMAT policy knob.
//
// The style packs have always asked for an ASCII `text` fenced diagram. The
// knob adds `illustration.diagramFormat` ("text" | "mermaid"), defaulting to
// "text" so every existing pack and every existing run is byte-identical. This
// suite pins the default path (the load-bearing property) and the mermaid
// opt-in behaviour on both the prompt and the linter.
//
// Scope: mechanism only. Surface rendering, "on request" semantics, and
// tree-first-class handling stay open (docs/ledger/W211-diagram-format-policy.md).

/** The prompt line every shipped pack emits today, pinned verbatim. */
const TEXT_DIAGRAM_RULE =
  "Where a section describes structure, flow, or a comparison, end it with a fenced ```text diagram. Use a fixed glyph set: \u2500\u2500\u25ba \u25b2 \u25bc \u2502 \u250c \u2510 \u2514 \u2518 \u251c \u2524.";

test("W211: diagramFormat defaults to text, leaving the existing pack shape unchanged", () => {
  const pack = StylePackSchema.parse({ id: "bare", mode: "notes" });
  assert.equal(pack.illustration.diagramFormat, "text");
});

test("W211: a default pack emits the exact current ```text diagram prompt (regression pin)", () => {
  const pack = StylePackSchema.parse({ id: "pin", mode: "notes" });
  const prompt = buildSystemPrompt(pack, "");
  assert.ok(
    prompt.includes(TEXT_DIAGRAM_RULE),
    "the default prompt must carry today's text diagram line verbatim",
  );
  assert.ok(!prompt.includes("mermaid"), "the default prompt must not mention mermaid");
});

test("W211: every shipped pack stays on the text format, byte-identical", () => {
  for (const id of ["notes", "essay", "hybrid"]) {
    const pack = loadStyle(id);
    assert.equal(pack.illustration.diagramFormat, "text", id + " must default to text");
    assert.ok(
      buildSystemPrompt(pack, "").includes(TEXT_DIAGRAM_RULE),
      id + " must carry the unchanged text diagram rule",
    );
  }
});

test("W211: a mermaid pack asks for a ```mermaid block instead", () => {
  const pack = StylePackSchema.parse({
    id: "vis",
    mode: "notes",
    illustration: { diagram: "optional", diagramFormat: "mermaid" },
  });
  const prompt = buildSystemPrompt(pack, "");
  assert.ok(prompt.includes("```mermaid"), "the prompt must request a mermaid fence");
  assert.match(prompt, /valid mermaid/i);
  assert.ok(!prompt.includes("```text"), "a mermaid pack must not ask for the text fence");
});

test("W211: diagram: off suppresses the diagram rule for either format", () => {
  const pack = StylePackSchema.parse({
    id: "off",
    mode: "notes",
    illustration: { diagram: "off", diagramFormat: "mermaid" },
  });
  const prompt = buildSystemPrompt(pack, "");
  assert.ok(prompt.includes("Do not add diagrams."));
  assert.ok(!prompt.includes("mermaid"), "an off pack must request no diagram at all");
});

test("W211: a text pack lints a ```text diagram exactly as before", () => {
  const pack = StylePackSchema.parse({
    id: "t",
    mode: "notes",
    illustration: { diagram: "required", diagramFormat: "text" },
    rules: { requireSourceLine: false },
  });
  const withText =
    "# T\n\nSource: x\n\n## A\n\n```text\nA \u2500\u2500\u25ba B\n```\n";
  const withoutText = "# T\n\nSource: x\n\n## A\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";

  assert.equal(
    lint(withText, pack).findings.filter((f) => f.rule === "diagram-required").length,
    0,
    "a text fence must satisfy a text pack",
  );
  assert.equal(
    lint(withoutText, pack).findings.filter((f) => f.rule === "diagram-required").length,
    1,
    "a mermaid fence must NOT satisfy a text pack",
  );
});

test("W211: a mermaid pack lints a ```mermaid diagram and rejects its absence", () => {
  const pack = StylePackSchema.parse({
    id: "m",
    mode: "notes",
    illustration: { diagram: "required", diagramFormat: "mermaid" },
    rules: { requireSourceLine: false },
  });
  const withMermaid =
    "# T\n\nSource: x\n\n## A\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
  const withText = "# T\n\nSource: x\n\n## A\n\n```text\nA \u2500\u2500\u25ba B\n```\n";
  const absent = "# T\n\nSource: x\n\n## A\n\nNo diagram here.\n";

  assert.equal(
    lint(withMermaid, pack).findings.filter((f) => f.rule === "diagram-required").length,
    0,
    "a mermaid fence must satisfy a mermaid pack",
  );
  assert.equal(
    lint(withText, pack).findings.filter((f) => f.rule === "diagram-required").length,
    1,
    "a text fence must NOT satisfy a mermaid pack",
  );
  assert.equal(
    lint(absent, pack).findings.filter((f) => f.rule === "diagram-required").length,
    1,
    "absence must be reported when diagram is required",
  );
});

test("W211: the diagram finding names the pack's own fence format", () => {
  const pack = StylePackSchema.parse({
    id: "m",
    mode: "notes",
    illustration: { diagram: "required", diagramFormat: "mermaid" },
    rules: { requireSourceLine: false },
  });
  const finding = lint("# T\n\nSource: x\n\n## A\n\nnone\n", pack).findings.find(
    (f) => f.rule === "diagram-required",
  );
  assert.ok(finding, "a required-diagram section with no diagram must be reported");
  assert.ok(finding!.message.includes("```mermaid"), "the finding must name the mermaid fence");
});
