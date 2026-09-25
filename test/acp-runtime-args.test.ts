// Fix/acp-pure-flag-v2: version-aware spawn args for the contained opencode
// agent. v2 removed `acp --pure` and prints its CLI help page to stdout for
// unknown flags — the first line is a bare `DESCRIPTION`, which kills every
// hub-composed turn at the ACP NDJSON decoder (verified live 2026-09-26).
import test from "node:test";
import assert from "node:assert/strict";

import { opencodeAcpArgs, parseOpencodeMajorVersion } from "../src/integrations/acp-runtime.js";

test("parseOpencodeMajorVersion reads v-prefixed and bare version strings", () => {
  assert.equal(parseOpencodeMajorVersion("opencode v2.0.10"), 2);
  assert.equal(parseOpencodeMajorVersion("1.18.31"), 1);
  assert.equal(parseOpencodeMajorVersion("v3.0.0-beta.1"), 3);
});

test("parseOpencodeMajorVersion fails closed on unparsable output", () => {
  assert.equal(parseOpencodeMajorVersion(""), undefined);
  assert.equal(parseOpencodeMajorVersion("garbage"), undefined);
  assert.equal(parseOpencodeMajorVersion("opencode"), undefined);
});

test("opencodeAcpArgs keeps --pure on the 1.x line", () => {
  assert.deepEqual([...opencodeAcpArgs(1)], ["acp", "--pure"]);
  assert.deepEqual([...opencodeAcpArgs(0)], ["acp", "--pure"]);
});

test("opencodeAcpArgs drops --pure on v2+ and unknown versions", () => {
  assert.deepEqual([...opencodeAcpArgs(2)], ["acp"]);
  assert.deepEqual([...opencodeAcpArgs(3)], ["acp"]);
  assert.deepEqual([...opencodeAcpArgs(undefined)], ["acp"]);
});