// W185: the v2 ACP session runner resolves `session.model` only, never the
// agent's frontmatter `model`, and the vendored fleet agents are `mode:
// subagent` (excluded from the ACP mode list). So the ACP lane pins a named
// fleet agent's tier as `selectModel` instead. These tests pin the seam
// (`fleetSelectModel`) and guarantee the historical config-model selection
// survives when no fleet agent is named (byte-identical for the ambient lane).
import test from "node:test";
import assert from "node:assert/strict";

import { fleetSelectModel } from "../src/integrations/acp-runtime.js";
import { OPENCODE_V2_METERED_PROVIDER_ID } from "../src/integrations/opencode-agent-config.js";

test("W185 ACP: a named fleet agent pins its tier as the session model", () => {
  // The pin is already metered-id-prefixed (the runtime install rewrote the
  // vendored `synthetic/` prefix to the metered id), so it is used verbatim.
  assert.equal(fleetSelectModel("executor", "deepseek/deepseek-flash"), `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:small:text`);
  assert.equal(fleetSelectModel("reviewer", "deepseek/deepseek-flash"), `${OPENCODE_V2_METERED_PROVIDER_ID}/syn:large:text`);
});

test("W185 ACP: no fleet agent (or an unpinned one) keeps the config-model selection", () => {
  // Absent fleet agent → the historical v2 picker translation, byte-identical.
  assert.equal(fleetSelectModel(undefined, "deepseek/deepseek-flash"), "deepseek/deepseek-v4-flash");
  // An unknown/operator agent has no pin → falls back, never a fabricated tier.
  assert.equal(fleetSelectModel("build", "deepseek/deepseek-flash"), "deepseek/deepseek-v4-flash");
});
