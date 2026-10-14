import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveRuntimeMeteredLane } from "../src/integrations/acp-runtime.js";
import { OPENROUTER_UPSTREAM, SYNTHETIC_KEY_ENV, SYNTHETIC_UPSTREAM } from "../src/integrations/synthetic-provider.js";

/**
 * The assistant lane egress must agree with every other agent lane: it resolves
 * its upstream through the SAME `resolveRuntimeMeteredLane` seam the server
 * runtime uses (`src/integrations/opencode-server-runtime.ts:290`), so it is
 * Synthetic-primary with an automatic OpenRouter failover when a Synthetic key
 * resolves, else OpenRouter single-upstream. An explicit `WORKFLOW_ACP_UPSTREAM`
 * always wins. The composition seam in `src/cli/opencode-server.ts` is not
 * exported for injection, so the last test documents the call there.
 *
 * Hermetic: the resolver reads the Synthetic key from the process env (`HOME` is
 * pointed at a fresh temp dir so no auth store or key file exists).
 */

/** Point HOME at an empty temp dir and restore the env after the test. */
function withEmptyHome(t: { after: (fn: () => void) => void }): void {
  const savedHome = process.env.HOME;
  const savedConfigured = process.env.WORKFLOW_ACP_UPSTREAM;
  const savedSynthetic = process.env[SYNTHETIC_KEY_ENV];
  t.after(() => {
    restore("HOME", savedHome);
    restore("WORKFLOW_ACP_UPSTREAM", savedConfigured);
    restore(SYNTHETIC_KEY_ENV, savedSynthetic);
  });
  process.env.HOME = mkdtempSync(join(tmpdir(), "assistant-egress-lane-"));
  delete process.env.WORKFLOW_ACP_UPSTREAM;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("assistant lane resolver: a Synthetic key makes Synthetic primary with an OpenRouter failover", (t) => {
  withEmptyHome(t);
  process.env[SYNTHETIC_KEY_ENV] = "SYN";

  const lane = resolveRuntimeMeteredLane("OR");
  assert.equal(lane.upstream, SYNTHETIC_UPSTREAM);
  assert.equal(lane.apiKey, "SYN");
  assert.equal(lane.failover?.primary, SYNTHETIC_UPSTREAM);
  assert.equal(lane.failover?.fallback, OPENROUTER_UPSTREAM);
  assert.equal(lane.failover?.openrouterApiKey, "OR");
});

test("assistant lane resolver: an explicit WORKFLOW_ACP_UPSTREAM wins (Synthetic auto-select disabled)", (t) => {
  withEmptyHome(t);
  process.env[SYNTHETIC_KEY_ENV] = "SYN";
  process.env.WORKFLOW_ACP_UPSTREAM = "https://upstream.example/";

  const lane = resolveRuntimeMeteredLane("OR");
  assert.equal(lane.upstream, "https://upstream.example/");
  assert.equal(lane.apiKey, "OR");
  assert.equal(lane.failover, undefined);
});

test("assistant lane resolver: no Synthetic key keeps today's OpenRouter single-upstream behavior", (t) => {
  withEmptyHome(t);

  const lane = resolveRuntimeMeteredLane("OR");
  assert.equal(lane.upstream, OPENROUTER_UPSTREAM);
  assert.equal(lane.apiKey, "OR");
  assert.equal(lane.failover, undefined);
});

test("assistant composition calls resolveRuntimeMeteredLane with no explicit upstream and threads the failover", () => {
  const source = readFileSync(new URL("../src/cli/opencode-server.ts", import.meta.url), "utf8");
  // No second argument: the local `upstream` literal must never be passed, or it
  // would be treated as an operator lock and disable the Synthetic auto-select.
  assert.match(source, /resolveRuntimeMeteredLane\(upstreamApiKey\)/);
  assert.match(source, /upstream: assistantLane\.upstream/);
  assert.match(source, /apiKey: assistantLane\.apiKey/);
  assert.match(
    source,
    /syntheticFailover: syntheticFailoverProxyOptions\(assistantLane\.failover\)/,
  );
});
