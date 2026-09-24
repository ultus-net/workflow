import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeControlPlaneText } from "../src/application/text-hygiene.js";

// W138: control-plane text hygiene — the named-class strip of hidden
// Unicode at the prompt seat. The module's contract is the CLASS TABLE
// itself: every named class strips (with its kind recorded), every
// preserved class survives byte-for-byte, and the function is idempotent.
// The strip is a denylist, not an "anything invisible" oracle — these pins
// are the boundary both ways.

test("W138: the bidi class strips (the reading-order spoofing controls)", () => {
  const raw = "legit\u202Egnp-legit\u061Ca\u200Eb\u200Fc\u2066x\u2069y\u202Az";
  const result = sanitizeControlPlaneText(raw);
  assert.equal(result.text, "legitgnp-legitabcxyz");
  assert.deepEqual(
    result.stripped.map((hit) => hit.kind),
    ["bidi", "bidi", "bidi", "bidi", "bidi", "bidi", "bidi"],
    "every bidi control is recorded with its kind",
  );
  assert.equal(result.stripped[0]?.codePoint, 0x202e);
});

test("W138: the zero-width class strips ZWSP, word joiner, and mid-text BOM — never ZWNJ/ZWJ", () => {
  const raw = "a\u200Bb\u2060c\uFEFFd";
  const result = sanitizeControlPlaneText(raw);
  assert.equal(result.text, "abcd");
  assert.deepEqual(
    result.stripped.map((hit) => [hit.kind, hit.codePoint]),
    [["zero-width", 0x200b], ["zero-width", 0x2060], ["zero-width", 0xfeff]],
  );
});

test("W138: the tag class strips the Unicode tag characters (the out-of-band channel)", () => {
  const raw = "vis\u{E0054}\u{E0041}ible";
  const result = sanitizeControlPlaneText(raw);
  assert.equal(result.text, "visible");
  assert.deepEqual(
    result.stripped.map((hit) => hit.kind),
    ["tag", "tag"],
  );
});

test("W138: the control class strips C0, DEL, and C1 — tab, newline, and CR survive", () => {
  const raw = "a\u0001b\u007Fc\u009Fd\te\nf\rg\u000Bh";
  const result = sanitizeControlPlaneText(raw);
  assert.equal(result.text, "abcd\te\nf\rgh", "VT strips; tab, newline, CR survive");
  assert.deepEqual(
    result.stripped.map((hit) => hit.kind),
    ["control", "control", "control", "control"],
  );
});

test("W138: the noncharacter class strips U+FDD0-U+FDEF and every plane's xxFFFE/xxFFFF", () => {
  const raw = "a\uFDD0b\uFFFEc\u{10FFFE}d\u{10FFFF}e\uFFFEf\u{1FFFF}g\uFFFDh";
  const result = sanitizeControlPlaneText(raw);
  assert.equal(result.text, "abcdefg\uFFFDh", "U+FFFD (the replacement char) is NOT a noncharacter");
  assert.equal(result.stripped.length, 6);
  assert.deepEqual(
    new Set(result.stripped.map((hit) => hit.kind)),
    new Set(["noncharacter"]),
  );
});

test("W138: preserved classes survive byte-for-byte — ZWNJ, ZWJ, variation selectors, NBSP, and ZWJ emoji sequences", () => {
  const raw = "café\u200Cnaïve\u200Dfamily\uFE0Fdone\u00A0nbsp";
  const result = sanitizeControlPlaneText(raw);
  assert.equal(result.text, raw, "the presentation/joining classes are the honest boundary");
  assert.deepEqual(result.stripped, []);
});

test("W138: the emoji ZWJ sequence 👨‍👩‍👧 is NEVER mangled (the overstrip guard)", () => {
  const raw = "family: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const result = sanitizeControlPlaneText(raw);
  assert.equal(result.text, raw, "ZWJ is load-bearing for emoji sequences");
  assert.deepEqual(result.stripped, []);
});

test("W138: clean text passes through untouched and the function is idempotent", () => {
  const clean = "Ordinary prompt text.\n\tSecond line — CJK: 円直, emoji: 🚀, math: x².";
  const first = sanitizeControlPlaneText(clean);
  assert.equal(first.text, clean);
  assert.deepEqual(first.stripped, []);
  const second = sanitizeControlPlaneText(first.text);
  assert.equal(second.text, clean);
  assert.deepEqual(second.stripped, [], "sanitizing sanitized text strips nothing");
});

test("W138: hits carry the exact code point so a surface can show what was removed", () => {
  const result = sanitizeControlPlaneText("\u202E\u0001");
  assert.deepEqual(result.stripped, [
    { kind: "bidi", codePoint: 0x202e },
    { kind: "control", codePoint: 0x01 },
  ]);
});