import assert from "node:assert/strict";
import test from "node:test";

import {
  LIMITS,
  boundedDuration,
  normalizeKey,
  validateAction,
  validateAssertion,
  validateHttpUrl,
  validateSelector,
  type BrowserAction,
} from "../src/bounds.js";

test("accepts only absolute http(s) URLs and enforces the optional origin allowlist", () => {
  assert.deepEqual(validateHttpUrl("https://app.test/path?q=1"), { url: "https://app.test/path?q=1", origin: "https://app.test" });
  assert.deepEqual(validateHttpUrl("http://127.0.0.1:8080/"), { url: "http://127.0.0.1:8080/", origin: "http://127.0.0.1:8080" });
  assert.throws(() => validateHttpUrl("file:///etc/passwd"), /scheme must be http or https/);
  assert.throws(() => validateHttpUrl("javascript:alert(1)"), /scheme must be http or https/);
  assert.throws(() => validateHttpUrl("not a url"), /absolute http\(s\) URL/);
  assert.throws(() => validateHttpUrl("https://app.test/", ["https://other.test"]), /not in the configured allowlist/);
  assert.deepEqual(validateHttpUrl("https://app.test/", ["https://app.test"]).origin, "https://app.test");
});

test("bounds selectors and rejects control characters", () => {
  assert.equal(validateSelector("  #name  "), "#name");
  assert.throws(() => validateSelector("   "), /must not be empty/);
  assert.throws(() => validateSelector("#a\n#b"), /Selector is invalid/);
  assert.throws(() => validateSelector("#" + "a".repeat(LIMITS.maxSelectorChars + 1)), /exceeds its/);
});

test("keeps the action surface to the allowlist and rejects script-like payloads", () => {
  assert.deepEqual(validateAction({ kind: "click", selector: "#greet" }), { kind: "click", selector: "#greet" });
  assert.deepEqual(validateAction({ kind: "type", selector: "#name", text: "World" }), { kind: "type", selector: "#name", text: "World" });
  assert.deepEqual(validateAction({ kind: "press", key: "Enter" }), { kind: "press", key: "Enter" });
  assert.deepEqual(validateAction({ kind: "press", key: "Enter", selector: "#name" }), { kind: "press", key: "Enter", selector: "#name" });
  assert.throws(() => validateAction({ kind: "evaluate", script: "1+1" } as unknown as BrowserAction), /Unsupported action/);
  assert.throws(() => validateAction({ kind: "press", key: "Meta" }), /not in the browser action allowlist/);
  assert.throws(() => validateAction({ kind: "type", selector: "#name", text: "a\u0000b" }), /control characters/);
});

test("bounds assertion shapes and rejects unknown assertion kinds", () => {
  assert.deepEqual(validateAssertion({ kind: "text_visible", text: "Hello" }), { kind: "text_visible", text: "Hello" });
  assert.throws(() => validateAssertion({ kind: "dom_query", script: "x" } as never), /Unsupported assertion/);
  assert.throws(() => validateAssertion({ kind: "url_contains", text: "a".repeat(LIMITS.maxPatternChars + 1) }), /exceeds its/);
});

test("normalizes only allowlisted keys and clamps durations", () => {
  assert.equal(normalizeKey("Enter").keyCode, 13);
  assert.throws(() => normalizeKey("F5"), /allowlist/);
  assert.equal(boundedDuration(Number.NaN, 1_000, 100, 10_000), 1_000);
  assert.equal(boundedDuration(-5, 1_000, 100, 10_000), 1_000);
  assert.equal(boundedDuration(99_999, 1_000, 100, 10_000), 10_000);
  assert.equal(boundedDuration(50, 1_000, 100, 10_000), 100);
});