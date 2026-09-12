import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_STYLES,
  SPEECH_STYLES,
  formatStyleStatus,
  nextBuildStyle,
  nextSpeechStyle,
  resolveStyleFromEnv,
  stylePromptAddendum,
} from "../src/integrations/response-style.js";

test("caveman speech style demands terse, stripped speech but keeps summaries", () => {
  const addendum = stylePromptAddendum({ speech: "caveman", build: "normal" });
  assert.match(addendum, /caveman/i);
  assert.match(addendum, /fewest words|short/i);
  assert.match(addendum, /no preamble|no filler/i);
  assert.match(addendum, /keep the summary/i);
});

test("ponytail build styles escalate YAGNI pressure with intensity", () => {
  const lite = stylePromptAddendum({ speech: "normal", build: "ponytail-lite" });
  const ultra = stylePromptAddendum({ speech: "normal", build: "ponytail-ultra" });
  assert.match(lite, /never wrote|simplest/i);
  assert.match(ultra, /delete|deletion/i);
  assert.ok(ultra.length > lite.length, "ultra should add stricter rules over lite");
});

test("normal styles produce no addendum and no token cost", () => {
  assert.equal(stylePromptAddendum({ speech: "normal", build: "normal" }), "");
});

test("styles cycle and resolve from environment", () => {
  assert.equal(nextSpeechStyle("normal"), "caveman");
  assert.equal(nextSpeechStyle("caveman"), "normal");
  assert.equal(nextBuildStyle("normal"), "ponytail-lite");
  assert.equal(nextBuildStyle("ponytail-lite"), "ponytail-full");
  assert.equal(nextBuildStyle("ponytail-full"), "ponytail-ultra");
  assert.equal(nextBuildStyle("ponytail-ultra"), "normal");
  assert.deepEqual(SPEECH_STYLES, ["normal", "caveman"]);
  assert.deepEqual(BUILD_STYLES, ["normal", "ponytail-lite", "ponytail-full", "ponytail-ultra"]);

  assert.deepEqual(
    resolveStyleFromEnv({ WORKFLOW_SPEECH_STYLE: "caveman", WORKFLOW_BUILD_STYLE: "ponytail-full" }),
    { speech: "caveman", build: "ponytail-full" },
  );
  assert.deepEqual(resolveStyleFromEnv({}), { speech: "normal", build: "normal" });
  assert.deepEqual(resolveStyleFromEnv({ WORKFLOW_SPEECH_STYLE: "bogus" }), { speech: "normal", build: "normal" });
});

test("formatStyleStatus renders the TUI mode-bar label compactly", () => {
  assert.equal(formatStyleStatus({ speech: "normal", build: "normal" }), "");
  assert.equal(formatStyleStatus({ speech: "caveman", build: "normal" }), "🪨");
  assert.equal(formatStyleStatus({ speech: "normal", build: "ponytail-lite" }), "pt·lite");
  assert.equal(formatStyleStatus({ speech: "caveman", build: "ponytail-ultra" }), "🪨 pt·ultra");
});
