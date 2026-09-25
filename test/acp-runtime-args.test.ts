// Fix/acp-pure-flag-v2: version-aware spawn args for the contained opencode
// agent. v2 removed `acp --pure` and prints its CLI help page to stdout for
// unknown flags — the first line is a bare `DESCRIPTION`, which kills every
// hub-composed turn at the ACP NDJSON decoder (verified live 2026-09-26).
import test from "node:test";
import assert from "node:assert/strict";

import {
  opencodeAcpArgs,
  opencodeMajorVersion,
  parseOpencodeMajorVersion,
} from "../src/integrations/acp-runtime.js";

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

// Wiring pin (review P1 + re-review P2, 2026-09-26): the PROBE itself must
// resolve the child's major version — execFile fires its callback with
// error === null on success, and an `error === undefined` regression made
// the probe always resolve undefined (silently flipping v1 to the v2 shape).
// A stub script prints a v1 version string; the probe must map it to 1 and
// hence the --pure shape. The negative path: a binary that cannot run
// (nonexistent path) fails closed to undefined -> the v2 shape.
test("opencodeMajorVersion resolves a real child's version and fails closed", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "acp-probe-"));
  const stub = join(dir, "fake-opencode.sh");
  writeFileSync(stub, "#!/bin/sh\necho 'opencode v1.18.31'\n", { mode: 0o755 });
  chmodSync(stub, 0o755);
  assert.equal(await opencodeMajorVersion(stub), 1);
  assert.deepEqual([...opencodeAcpArgs(await opencodeMajorVersion(stub))], ["acp", "--pure"]);
  const missing = join(dir, "no-such-binary");
  assert.equal(await opencodeMajorVersion(missing), undefined);
  assert.deepEqual([...opencodeAcpArgs(await opencodeMajorVersion(missing))], ["acp"]);
});