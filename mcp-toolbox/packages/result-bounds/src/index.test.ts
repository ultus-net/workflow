import assert from "node:assert/strict";
import test from "node:test";

import { boundJsonText, boundToolResultText, boundText, DEFAULT_MAX_RESULT_CHARS } from "./index.js";

test("boundText returns short values untouched", () => {
  assert.deepEqual(boundText("hello"), { text: "hello", truncated: false });
  assert.deepEqual(boundText("hello", 10), { text: "hello", truncated: false });
  assert.equal(boundText("x".repeat(DEFAULT_MAX_RESULT_CHARS)).truncated, false);
});

test("boundText middle-cuts with a visible marker, keeping head and tail", () => {
  const value = "HEAD" + "x".repeat(400) + "TAIL";
  const bounded = boundText(value, 200);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.startsWith("HEAD"), "the informative head survives");
  assert.ok(bounded.text.endsWith("TAIL"), "the informative tail survives");
  assert.match(bounded.text, /\[\.\.\. \d+ characters truncated \(result-bounds middle-cut\) \.\.\.\]/);
  assert.ok(bounded.text.length <= 200, "the bound holds");
});

test("boundText falls back to a head-only cut when the cap cannot fit a marker", () => {
  const value = "HEAD" + "x".repeat(400) + "TAIL";
  const bounded = boundText(value, 40);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.length <= 40, "tiny caps still hold");
  assert.match(bounded.text, /\[\.\.\. \+\d+ truncated \.\.\.\]/);
});

test("boundText budget never exceeds the cap after the marker", () => {
  const value = "a".repeat(1_000_000);
  for (const cap of [40, 1_000, 48_000]) {
    const bounded = boundText(value, cap);
    assert.ok(bounded.text.length <= cap, `cap ${cap} respected`);
    assert.ok(bounded.text.includes("truncated"), `cap ${cap} marks the cut`);
  }
});

test("boundJsonText serializes and bounds the model-visible text", () => {
  const payload = { items: Array.from({ length: 5_000 }, (_, index) => ({ index, message: "m".repeat(50) })) };
  const bounded = boundJsonText(payload, 2_000);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.startsWith("{"));
  assert.ok(bounded.text.length <= 2_000);
  assert.ok(boundJsonText({ ok: true }, 2_000).text.endsWith("}"), "small payloads stay intact");
});

test("boundToolResultText bounds text blocks and leaves everything else alone", () => {
  const small = {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { diagnostics: [] },
  };
  assert.deepEqual(boundToolResultText(small), small);

  const large = {
    content: [
      { type: "text", text: "x".repeat(100_000) },
      { type: "resource", resource: { uri: "workflow://x" } },
    ],
    structuredContent: { big: true },
  };
  const bounded = boundToolResultText(large, 1_000) as typeof large;
  assert.equal((bounded.content[0] as { text: string }).text.length, 1_000);
  assert.match((bounded.content[0] as { text: string }).text, /characters truncated/);
  assert.deepEqual(bounded.content[1], large.content[1], "non-text blocks pass through");
  assert.deepEqual(bounded.structuredContent, { big: true }, "structured content is never modified");
  assert.equal(boundToolResultText(null), null);
  assert.deepEqual(boundToolResultText({ noContent: true }), { noContent: true });
});