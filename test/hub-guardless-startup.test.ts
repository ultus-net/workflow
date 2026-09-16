import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { createWorkflowGuardMcpProvider } from "../src/integrations/mcp-toolbox-guard.js";

test("the guard provider composition fails closed when the guard server cannot start", async () => {
  // Plan Task G2: the hub's startup awaits the guard provider at top level
  // (src/cli/hub.ts). A provider that cannot start must REJECT — never
  // resolve into a serving-but-guardless hub. A nonexistent server entry is
  // the minimal honest stand-in for "the guard could not start": the stdio
  // transport spawns it, the spawn exits without speaking MCP, and the
  // connect must surface that as a startup failure.
  const missing = join(import.meta.dirname, "no-such-guard-server.js");
  await assert.rejects(
    createWorkflowGuardMcpProvider({ serverPath: missing }),
    /no-such-guard-server|spawn|connect|ENOTFOUND|MODULE_NOT_FOUND|Cannot find/i,
  );
});

test("a resolved provider is never returned for a failed guard handshake", async () => {
  // The fail-closed property is directional: there is no path where a
  // broken guard yields a working provider whose guardCheck would then
  // answer permissively. Driving the same failure twice proves the
  // rejection is deterministic, not a race that could resolve instead.
  const missing = join(import.meta.dirname, "no-such-guard-server.js");
  await assert.rejects(createWorkflowGuardMcpProvider({ serverPath: missing }));
  await assert.rejects(createWorkflowGuardMcpProvider({ serverPath: missing }));
});
