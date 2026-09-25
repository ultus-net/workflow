import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS, bashTimeoutMs } from "../src/integrations/hub-http.js";

// W144: the /bash lane's bounded-execute cap — the named seam. Default
// 120s; the WORKFLOW_HUB_BASH_TIMEOUT_MS override must be a positive integer
// in milliseconds; anything else (absent, zero, negative, fractional,
// non-numeric) falls back to the documented default. Fail-open to the
// CONSTANT, never to unbounded.

test("W144: the cap default is the named 120s constant", () => {
  assert.equal(DEFAULT_BASH_TIMEOUT_MS, 120_000);
  assert.equal(bashTimeoutMs({}), DEFAULT_BASH_TIMEOUT_MS);
});

test("W144: a valid override rides through verbatim", () => {
  assert.equal(bashTimeoutMs({ WORKFLOW_HUB_BASH_TIMEOUT_MS: "750" }), 750);
  assert.equal(bashTimeoutMs({ WORKFLOW_HUB_BASH_TIMEOUT_MS: "1" }), 1);
});

test("W144: garbage overrides fall back to the default, never to unbounded", () => {
  for (const raw of ["0", "-5", "12.5", "abc", "", "750ms", " "]) {
    assert.equal(bashTimeoutMs({ WORKFLOW_HUB_BASH_TIMEOUT_MS: raw }), DEFAULT_BASH_TIMEOUT_MS, `override ${JSON.stringify(raw)} falls back`);
  }
});

test("W144: a numeric-string override that parses to a positive integer rides through (1e3 = 1000)", () => {
  assert.equal(bashTimeoutMs({ WORKFLOW_HUB_BASH_TIMEOUT_MS: "1e3" }), 1000);
});

test("W144: an operator-explicit env cannot smuggle the unbounded lane back — the clamp is MAX_BASH_TIMEOUT_MS", () => {
  assert.equal(MAX_BASH_TIMEOUT_MS, 3_600_000);
  assert.equal(bashTimeoutMs({ WORKFLOW_HUB_BASH_TIMEOUT_MS: "99999999999999999999" }), MAX_BASH_TIMEOUT_MS);
  assert.equal(bashTimeoutMs({ WORKFLOW_HUB_BASH_TIMEOUT_MS: "7200000" }), MAX_BASH_TIMEOUT_MS);
});