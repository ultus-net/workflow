import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DEFAULT_SSE_KEEPALIVE_MS,
  SSE_KEEPALIVE_FRAME,
  sseKeepaliveMs,
} from "../src/integrations/opencode-server-gateway.js";

/**
 * `infra/c0/README.md` states the event-stream keepalive recipe: the interval,
 * the override rule, the identity-only coverage, the re-verify commands, and
 * the honest residual. A recipe that drifts from the code it describes is worse
 * than no recipe — an operator would tune the wrong number. These pins read the
 * live gateway constants and the doc together, so changing the interval, the
 * frame, or the override rule fails here until the doc is updated with it.
 *
 * The honesty pins are load-bearing in the other direction: a doc that quietly
 * upgraded "advisory" into a deployed-ingress qualification would fail, because
 * no such qualification has been probed (see docs/HOST_ADAPTERS.md, 2026-09-26).
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readme = readFileSync(join(repoRoot, "infra", "c0", "README.md"), "utf8");

test("the recipe states the keepalive interval the gateway actually defaults to", () => {
  assert.ok(
    readme.includes(`DEFAULT_SSE_KEEPALIVE_MS = ${DEFAULT_SSE_KEEPALIVE_MS}`),
    "the recipe must name the exported default verbatim, so a constant change breaks this pin",
  );
  const seconds = DEFAULT_SSE_KEEPALIVE_MS / 1000;
  assert.equal(seconds, 15, "the pinned default is 15s; a change here is a deliberate recipe change");
  assert.ok(
    readme.includes(`**${seconds}s**`),
    "the recipe must state the interval in the units an operator reads (15s)",
  );
  assert.ok(
    readme.includes("~4-minute ingress idle window"),
    "the recipe must name the idle window the default is chosen against",
  );
});

test("the recipe states the exact frame the gateway writes", () => {
  assert.ok(
    readme.includes(JSON.stringify(SSE_KEEPALIVE_FRAME)),
    "the recipe must quote the exported frame verbatim, so a frame change breaks this pin",
  );
  assert.ok(
    readme.includes("no `event:` and no `data:` field"),
    "the recipe must keep the reason a comment frame is parser-inert",
  );
});

test("the recipe's override rule matches sseKeepaliveMs", () => {
  assert.ok(readme.includes("WORKFLOW_SSE_KEEPALIVE_MS"), "the recipe must name the override variable");
  // Every value the doc's fallback table claims falls back must actually fall
  // back, and a positive integer must actually override.
  assert.equal(sseKeepaliveMs({ WORKFLOW_SSE_KEEPALIVE_MS: "40000" }), 40_000);
  for (const raw of ["", "0", "-1", "1.5", "abc"]) {
    assert.equal(
      sseKeepaliveMs({ WORKFLOW_SSE_KEEPALIVE_MS: raw }),
      DEFAULT_SSE_KEEPALIVE_MS,
      `${JSON.stringify(raw)} must fall back to the default`,
    );
    assert.ok(
      readme.includes(`\`${raw}\``),
      `the recipe's fallback table must list ${JSON.stringify(raw)} as falling back`,
    );
  }
  assert.equal(sseKeepaliveMs({}), DEFAULT_SSE_KEEPALIVE_MS);
});

test("the recipe states the identity-only coverage and the deliberate gzip exclusion", () => {
  assert.ok(readme.includes("`content-encoding` is empty or `identity`"), "the recipe must state the covered encodings");
  assert.ok(
    readme.includes("gzip streams are deliberately\nexcluded"),
    "the recipe must state that gzip is excluded on purpose, not by omission",
  );
  assert.ok(
    readme.includes("proxied\nbyte-identical"),
    "the recipe must state what a gzip stream actually gets instead",
  );
});

test("the recipe's re-verify commands name tests that exist", () => {
  for (const file of ["opencode-server-gateway-ingress-probe.test.ts", "opencode-server-gateway.test.ts"]) {
    assert.ok(
      readme.includes(`node --import tsx --test test/${file}`),
      `the recipe must give the focused re-verify command for ${file} (never the full npm test)`,
    );
    assert.ok(
      existsSync(join(repoRoot, "test", file)),
      `${file} must exist: a recipe pointing at a renamed test is drift`,
    );
  }
});

test("the recipe keeps its claims advisory and states the residual", () => {
  for (const honesty of [
    "transport liveness only",
    "not a deployed-ingress\nqualification",
    "**advisory**",
    "never evidence that upstream is alive",
    "no `docs/PROBE_VERDICTS.json` row",
  ]) {
    assert.ok(readme.includes(honesty), `the recipe must keep the honesty statement: ${honesty}`);
  }
  assert.ok(
    readme.includes("docs/HOST_ADAPTERS.md"),
    "the recipe must point at the dated record rather than restate history",
  );
});
