import assert from "node:assert/strict";
import test from "node:test";

import { conformanceSummary, runConformance } from "./conformance.js";
import { findWorkspaceRoot } from "./paths.js";

const root = findWorkspaceRoot();

test("every toolbox product passes the MCP 2026-07-28 conformance smoke", async () => {
  const reports = await runConformance(root);
  const failures = reports.filter((report) => !report.passed);
  const detail = failures
    .map((report) => `${report.app}: ${report.checks.filter((check) => !check.passed).map((check) => `${check.name} (${check.detail})`).join(", ")}`)
    .join(" | ");
  assert.equal(failures.length, 0, detail);
  const summary = conformanceSummary(reports);
  assert.equal(summary.apps, 14);
  assert.equal(summary.failed.length, 0);
});

test("the conformance smoke asserts the tasks extension on the task product", async () => {
  const reports = await runConformance(root);
  const taskReport = reports.find((report) => report.app === "verification-accountability-mcp");
  assert.ok(taskReport);
  const names = taskReport.checks.map((check) => check.name);
  assert.ok(names.includes("tasks_extension"));
  assert.ok(names.includes("tasks_capability"));
  assert.ok(taskReport.checks.every((check) => check.passed), JSON.stringify(taskReport.checks));
});