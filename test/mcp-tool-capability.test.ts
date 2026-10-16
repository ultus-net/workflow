import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCapability } from "../src/application/host.js";
import {
  classifyMcpTool,
  classFromAnnotations,
  mergeCapabilityMap,
  parseMcpToolCapabilityMap,
  STRICTEST_MCP_TOOL_CLASS,
} from "../src/integrations/mcp-tool-capability.js";

test("classifyMcpTool: declared hit returns the declared class", () => {
  const map: Record<string, { capability: ToolCapability; mutating: boolean }> = {
    testTool: { capability: "read", mutating: false },
  };
  const result = classifyMcpTool("testTool", map);
  assert.equal(result.capability, "read");
  assert.equal(result.mutating, false);
});

test("classifyMcpTool: absent name returns process + mutating (strictest default)", () => {
  const map: Record<string, { capability: ToolCapability; mutating: boolean }> = {
    otherTool: { capability: "network", mutating: true },
  };
  assert.deepEqual(
    classifyMcpTool("missingTool", map),
    STRICTEST_MCP_TOOL_CLASS,
  );
});

test("classifyMcpTool: blank name returns the strictest default", () => {
  const map: Record<string, { capability: ToolCapability; mutating: boolean }> = {
    otherTool: { capability: "spawn", mutating: true },
  };
  assert.deepEqual(classifyMcpTool("", map), STRICTEST_MCP_TOOL_CLASS);
  assert.deepEqual(classifyMcpTool("   ", map), STRICTEST_MCP_TOOL_CLASS);
});

test("classFromAnnotations: readOnlyHint: true → read class (non-mutating)", () => {
  const result = classFromAnnotations({ readOnlyHint: true });
  assert.equal(result.capability, "read");
  assert.equal(result.mutating, false);
});

test("classFromAnnotations: readOnlyHint: false → mutation class (mutating)", () => {
  const result = classFromAnnotations({ readOnlyHint: false });
  assert.equal(result.capability, "mutation");
  assert.equal(result.mutating, true);
});

test("classFromAnnotations: missing readOnlyHint defaults to mutation (mutating)", () => {
  const result = classFromAnnotations({});
  assert.equal(result.capability, "mutation");
  assert.equal(result.mutating, true);
});

test("mergeCapabilityMap: operator override beats the annotation", () => {
  const annotations: Record<string, { readOnlyHint?: boolean }> = {
    learner_profile: { readOnlyHint: true },
  };
  const override: Record<string, { capability: ToolCapability; mutating: boolean }> = {
    learner_profile: { capability: "network", mutating: true },
  };
  const merged = mergeCapabilityMap(annotations, override);
  const profile = merged.learner_profile as { capability: ToolCapability; mutating: boolean };
  assert.equal(profile.capability, "network");
  assert.equal(profile.mutating, true);
});

test("mergeCapabilityMap: the annotation seed governs a tool the operator left undeclared", () => {
  const annotations: Record<string, { readOnlyHint?: boolean }> = {
    learner_profile: { readOnlyHint: true },
    learning_checkpoint: { readOnlyHint: false },
  };
  const override: Record<string, { capability: ToolCapability; mutating: boolean }> = {
    learner_profile: { capability: "network", mutating: true },
  };
  const merged = mergeCapabilityMap(annotations, override);
  // The overridden tool takes the operator class.
  assert.equal(merged.learner_profile!.capability, "network");
  // The undeclared tool keeps its annotation seed.
  assert.equal(merged.learning_checkpoint!.capability, "mutation");
  assert.equal(merged.learning_checkpoint!.mutating, true);
});

test("mergeCapabilityMap: neither input is mutated", () => {
  const annotations: Record<string, { readOnlyHint?: boolean }> = { a: { readOnlyHint: true } };
  const override: Record<string, { capability: ToolCapability; mutating: boolean }> = {
    b: { capability: "read", mutating: false },
  };
  const merged = mergeCapabilityMap(annotations, override);
  assert.deepEqual(annotations, { a: { readOnlyHint: true } }, "annotations unchanged");
  assert.deepEqual(override, { b: { capability: "read", mutating: false } }, "override unchanged");
  assert.deepEqual(Object.keys(merged).sort(), ["a", "b"], "the merged map carries both tools");
});

test("parseMcpToolCapabilityMap: throws on non-object input", () => {
  assert.throws(
    () => parseMcpToolCapabilityMap("not an object"),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(String(err), /must be an object/);
      return true;
    },
  );
});

test("parseMcpToolCapabilityMap: throws on unknown capability string", () => {
  const input: Record<string, unknown> = {
    badTool: { capability: "invalid", mutating: true },
  };
  assert.throws(
    () => parseMcpToolCapabilityMap(input),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(String(err), /unknown capability/);
      return true;
    },
  );
});

test("parseMcpToolCapabilityMap: throws on non-boolean mutating", () => {
  const input: Record<string, unknown> = {
    badTool: { capability: "read", mutating: "not a boolean" },
  };
  assert.throws(
    () => parseMcpToolCapabilityMap(input),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(String(err), /boolean mutating flag/);
      return true;
    },
  );
});

test("parseMcpToolCapabilityMap: accepts a well-formed map", () => {
  const input = {
    readTool: { capability: "read", mutating: false },
    mutationTool: { capability: "mutation", mutating: true },
    processTool: { capability: "process", mutating: true },
    spawnTool: { capability: "spawn", mutating: true },
    credentialsTool: { capability: "credentials", mutating: true },
    networkTool: { capability: "network", mutating: true },
  };
  const result = parseMcpToolCapabilityMap(input);
  assert.equal(Object.keys(result).length, 6);
  assert.equal(result.readTool!.capability, "read");
  assert.equal(result.readTool!.mutating, false);
  assert.equal(result.mutationTool!.capability, "mutation");
  assert.equal(result.mutationTool!.mutating, true);
  assert.equal(result.processTool!.capability, "process");
  assert.equal(result.processTool!.mutating, true);
  assert.equal(result.spawnTool!.capability, "spawn");
  assert.equal(result.spawnTool!.mutating, true);
  assert.equal(result.credentialsTool!.capability, "credentials");
  assert.equal(result.credentialsTool!.mutating, true);
  assert.equal(result.networkTool!.capability, "network");
  assert.equal(result.networkTool!.mutating, true);
});

test("learner_profile seeded from classFromAnnotations readOnlyHint: true classifies as read + non-mutating", () => {
  const learnerProfileClass = classFromAnnotations({ readOnlyHint: true });
  assert.equal(learnerProfileClass.capability, "read");
  assert.equal(learnerProfileClass.mutating, false);
});

test("learning_checkpoint seeded from classFromAnnotations readOnlyHint: false classifies as mutation + mutating", () => {
  const checkpointClass = classFromAnnotations({ readOnlyHint: false });
  assert.equal(checkpointClass.capability, "mutation");
  assert.equal(checkpointClass.mutating, true);
});
