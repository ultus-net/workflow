import assert from "node:assert/strict";
import test from "node:test";

import { measurePortfolio } from "./measure.js";
import { findWorkspaceRoot } from "./paths.js";

const root = findWorkspaceRoot();

test("the compact progressive index is strictly smaller than the full catalog", async () => {
  const measurement = await measurePortfolio(root);
  assert.equal(measurement.apps.length, 16);
  assert.ok(measurement.totals.tools >= 19, `expected at least 19 tools, got ${measurement.totals.tools}`);
  assert.ok(
    measurement.totals.toolIndexBytes < measurement.totals.catalogBytes,
    `index ${measurement.totals.toolIndexBytes} !< catalog ${measurement.totals.catalogBytes}`,
  );
  assert.ok(measurement.totals.savingsPercent > 50, `expected >50% savings, got ${measurement.totals.savingsPercent}%`);
  for (const app of measurement.apps) {
    assert.ok(app.catalogBytes > 0, `${app.app} measured zero catalog bytes`);
    assert.ok(app.toolIndexBytes < app.catalogBytes, `${app.app} index is not smaller than its catalog`);
  }
});