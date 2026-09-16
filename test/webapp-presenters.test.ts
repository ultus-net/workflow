import assert from "node:assert/strict";
import test from "node:test";

import { diffLineClass, looksLikeDiff } from "../src/ui/webapp/diff-text.js";
import { describeActivity, formatElapsed, formatRelativeTime } from "../src/ui/webapp/presenters.js";

test("looksLikeDiff accepts real unified diffs", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " context",
    "+added",
    "-removed",
  ].join("\n");
  assert.equal(looksLikeDiff(diff), true);
  assert.equal(looksLikeDiff("@@ -1 +1 @@\n+only additions"), true);
});

test("looksLikeDiff rejects non-diff content even with +/- line prefixes", () => {
  // Markdown bullets and flag lists must never tint as deletions (P2 finding).
  assert.equal(looksLikeDiff("- first\n- second\n- third"), false);
  assert.equal(looksLikeDiff("+ one\n+ two\n+ three"), false);
  assert.equal(looksLikeDiff(""), false);
  assert.equal(looksLikeDiff("plain text\nmore text"), false);
});

test("diffLineClass classifies hunk headers, file markers, and changes", () => {
  assert.equal(diffLineClass("@@ -10,7 +10,8 @@ function x()"), "diff-hunk");
  assert.equal(diffLineClass("diff --git a/x b/x"), "diff-meta");
  assert.equal(diffLineClass("index 111..222 100644"), "diff-meta");
  assert.equal(diffLineClass("+++ b/src/a.ts"), "diff-meta");
  assert.equal(diffLineClass("--- a/src/a.ts"), "diff-meta");
  assert.equal(diffLineClass("new file mode 100644"), "diff-meta");
  assert.equal(diffLineClass("+added line"), "diff-add");
  assert.equal(diffLineClass("+"), "diff-add");
  assert.equal(diffLineClass("-removed line"), "diff-del");
  assert.equal(diffLineClass(" unchanged"), "diff-ctx");
  // Known, documented ambiguity: a deletion whose content starts with `--`.
  assert.equal(diffLineClass("--- sql comment deleted"), "diff-meta");
});

test("formatRelativeTime buckets by recency", () => {
  const now = new Date("2026-09-17T12:00:00Z").getTime();
  const at = (iso: string): string => formatRelativeTime(iso, now);
  assert.equal(at("2026-09-17T11:59:30Z"), "just now");
  assert.equal(at("2026-09-17T11:55:00Z"), "5m ago");
  assert.equal(at("2026-09-17T09:00:00Z"), "3h ago");
  assert.equal(at("2026-09-15T12:00:00Z"), "2d ago");
  assert.match(at("2026-09-01T12:00:00Z"), /^Sep \d+$/);
});

test("formatElapsed renders seconds then minutes", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(45), "45s");
  assert.equal(formatElapsed(60), "1m 0s");
  assert.equal(formatElapsed(75), "1m 15s");
});

test("describeActivity reports the latest unfinished work", () => {
  assert.equal(describeActivity([]), "working…");
  assert.equal(
    describeActivity([
      { kind: "assistant", text: "partial" },
      { kind: "tool", callId: "t1", title: "Run npm test", toolKind: "execute", status: "in_progress", subjects: [] },
    ]),
    "Run npm test",
  );
  assert.equal(
    describeActivity([
      { kind: "tool", callId: "t1", title: "Read file", toolKind: "read", status: "pending", subjects: [] },
    ]),
    "Read file — awaiting",
  );
  assert.equal(describeActivity([{ kind: "thinking", text: "hmm" }]), "thinking…");
  assert.equal(describeActivity([{ kind: "assistant", text: "text" }]), "writing…");
  assert.equal(describeActivity([{ kind: "plan", entries: [] }]), "planning…");
  // Completed tools alone are not the live activity.
  assert.equal(
    describeActivity([
      { kind: "tool", callId: "t1", title: "Read file", toolKind: "read", status: "completed", subjects: [] },
    ]),
    "working…",
  );
});
