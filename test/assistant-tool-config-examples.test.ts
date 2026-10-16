import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAssistantMcpToolServerMap } from "../src/integrations/assistant-mcp-dispatcher.js";
import { parseMcpToolCapabilityMap } from "../src/integrations/mcp-tool-capability.js";

// W207 (M6 evidence half): the two checked-in assistant config examples the
// deployed plane points `WORKFLOW_ASSISTANT_MCP_TOOLS` and
// `WORKFLOW_ASSISTANT_TOOL_CAPABILITIES` at. The test runs the REAL parsers on
// the REAL files, so a drift between the examples and the parsers (a renamed
// tool, an unknown capability string) fails here rather than at plane start.

const mcpToolsPath = fileURLToPath(new URL("../docs/assistant-config/mcp-tools.json", import.meta.url));
const capabilitiesPath = fileURLToPath(new URL("../docs/assistant-config/tool-capabilities.json", import.meta.url));

test("W207: the example MCP-tool map resolves the learning-evidence tools to learning-mcp", () => {
  const map = parseAssistantMcpToolServerMap(JSON.parse(readFileSync(mcpToolsPath, "utf8")));
  assert.equal(map["record_learning_evidence"], "learning-mcp");
  assert.equal(map["learning_checkpoint"], "learning-mcp");
});

test("W207: the example capability map declares both learning-evidence tools as mutating", () => {
  const map = parseMcpToolCapabilityMap(JSON.parse(readFileSync(capabilitiesPath, "utf8")));
  assert.deepEqual(map["record_learning_evidence"], { capability: "mutation", mutating: true });
  assert.deepEqual(map["learning_checkpoint"], { capability: "mutation", mutating: true });
});
