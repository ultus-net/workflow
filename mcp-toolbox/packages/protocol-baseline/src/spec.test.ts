import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FEATURE_SURVEY, findFeature, surveySummary } from "./spec.js";

test("the installed SDK matches the surveyed 2026-07-28 baseline line", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.match(manifest.version, /^1\.30\./, `expected SDK 1.30.x, got ${manifest.version}`);
});

test("every 2026-07-28 feature carries SDK evidence and a disposition", () => {
  assert.equal(FEATURE_SURVEY.length, 9);
  for (const feature of FEATURE_SURVEY) {
    assert.ok(feature.sdkEvidence.length > 0, `${feature.id} has no sdkEvidence`);
    assert.ok(feature.toolboxDisposition.length > 0, `${feature.id} has no disposition`);
  }
});

test("features the SDK does not provide are recorded absent, not hand-rolled", () => {
  assert.equal(findFeature("server-discover").sdkSupport, "absent");
  assert.equal(findFeature("ttl-list-caching").sdkSupport, "absent");
  assert.equal(findFeature("enterprise-managed-authorization").sdkSupport, "absent");
  assert.match(findFeature("server-discover").toolboxDisposition, /Not adopted/);
});

test("features the SDK does provide are recorded native and adopted", () => {
  assert.equal(findFeature("tasks-extension").sdkSupport, "native");
  assert.equal(findFeature("stateless-serving").sdkSupport, "native");
  assert.equal(findFeature("tool-result-contract").sdkSupport, "native");
  assert.match(findFeature("tasks-extension").toolboxDisposition, /Adopted/);
});

test("survey summary totals the support classes", () => {
  const summary = surveySummary();
  const total = summary.counts.native + summary.counts.partial + summary.counts.absent;
  assert.equal(total, FEATURE_SURVEY.length);
  assert.equal(summary.specVersion, "2026-07-28");
});