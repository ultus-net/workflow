import assert from "node:assert/strict";
import test from "node:test";

import { remoteProbe } from "./acp-remote-probe-helpers.js";

/**
 * LIVE probe (M2): the remote ruleset actually asks before mutating.
 *
 * Gated: WORKFLOW_ACP_REMOTE_RULE_CONFIG=1 plus WORKFLOW_ACP_REMOTE_URL and
 * credentials. Reads `GET /config` and asserts the permission ruleset contains
 * an `ask` rule — the precondition for `enforced` (spec section 3). Skips
 * without its gate.
 */

const run = process.env.WORKFLOW_ACP_REMOTE_RULE_CONFIG === "1";
const probe = remoteProbe();

test("remote ACP rule-config probe: the ruleset contains an ask rule", { skip: !run || probe === undefined, timeout: 60_000 }, async () => {
  const { engine, cwd } = probe!;
  const config = await engine.config({ cwd });
  assert.ok(config, "GET /config must return the effective configuration");
  assert.ok(
    JSON.stringify(config).includes('"ask"'),
    "the effective permission ruleset must contain an ask rule for the surface to be enforceable",
  );
});
