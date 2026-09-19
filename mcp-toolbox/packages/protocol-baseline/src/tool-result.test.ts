import assert from "node:assert/strict";
import test from "node:test";

import type { Catalog, CatalogTool } from "./catalog.js";
import { RESULT_SHAPE_POLICY, canonicalResult, classifyResultForm, contractViolations } from "./tool-result.js";

function catalog(tools: readonly CatalogTool[]): Catalog {
  return { appDir: "test", tools, capabilities: {}, serverInfo: {} };
}

test("classifies the three declared result forms", () => {
  assert.equal(classifyResultForm({ name: "a", inputSchema: {}, outputSchema: {} }), "structured");
  assert.equal(classifyResultForm({ name: "b", inputSchema: {} }), "content-only");
  assert.equal(classifyResultForm({ name: "c" }), "ambiguous");
});

test("contract violations name every undeclared result shape", () => {
  const violations = contractViolations(
    catalog([
      { name: "structured", inputSchema: {}, outputSchema: {} },
      { name: "content-only", inputSchema: {} },
      { name: "ambiguous" },
    ]),
    ["content-only"],
  );
  assert.deepEqual(violations.map((violation) => violation.tool), ["ambiguous"]);
  assert.match(violations[0]?.reason ?? "", /no result shape/);
});

test("allowlisted content-only tools pass the contract", () => {
  const violations = contractViolations(catalog([{ name: "guard_status", inputSchema: {} }]), ["guard_status"]);
  assert.equal(violations.length, 0);
});

test("canonicalResult emits exactly one structured form", () => {
  const result = canonicalResult({ outcome: "ok" });
  assert.deepEqual(result, { structuredContent: { outcome: "ok" } });
  assert.equal("content" in result, false);
  assert.equal(RESULT_SHAPE_POLICY.canonical, "structuredContent");
});