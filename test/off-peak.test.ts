import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GLM_OFF_PEAK,
  deepseekOffPeakSpec,
  isOffPeak,
  offPeakSpec,
  parseUtcPeakWindow,
} from "../src/integrations/off-peak.js";

/**
 * W070a: deterministic off-peak windows. GLM's window is verified from vendor
 * docs; DeepSeek's exact hours are published only as an image, so they are
 * operator-provided and `undefined` (fail-open) until configured.
 */

const utc = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(Date.UTC(y, m - 1, d, h, min, 0, 0));

test("GLM off-peak is the complement of Mon-Fri 06:00-10:00 UTC", () => {
  // 2026-09-18 is a Friday; 2026-09-19 is a Saturday.
  assert.equal(isOffPeak("glm", utc(2026, 9, 18, 9, 0), GLM_OFF_PEAK), false, "Friday 09:00 UTC is peak");
  assert.equal(isOffPeak("glm", utc(2026, 9, 18, 5, 59), GLM_OFF_PEAK), true, "before the peak window is off-peak");
  assert.equal(isOffPeak("glm", utc(2026, 9, 18, 10, 0), GLM_OFF_PEAK), true, "the end is exclusive");
  assert.equal(isOffPeak("glm", utc(2026, 9, 19, 7, 0), GLM_OFF_PEAK), true, "all weekend is off-peak");
  assert.equal(isOffPeak("glm", utc(2026, 9, 20, 7, 0), GLM_OFF_PEAK), true);
});

test("DeepSeek's window is unknown until an operator supplies it", () => {
  assert.equal(offPeakSpec("deepseek", {}), undefined);
  assert.equal(isOffPeak("deepseek", utc(2026, 9, 18, 12, 0), undefined), undefined);

  const spec = deepseekOffPeakSpec({ WORKFLOW_OFF_PEAK_DEEPSEEK_PEAK_UTC: "00:30-16:30" });
  assert.ok(spec !== undefined);
  assert.equal(isOffPeak("deepseek", utc(2026, 9, 18, 12, 0), spec), false, "inside the configured peak window");
  assert.equal(isOffPeak("deepseek", utc(2026, 9, 18, 17, 0), spec), true, "outside the configured peak window");
});

test("parseUtcPeakWindow validates and rejects midnight-wrapping ranges", () => {
  assert.deepEqual(parseUtcPeakWindow("00:30-16:30"), { startMinute: 30, endMinute: 16 * 60 + 30, days: [] });
  for (const bad of ["", "16:30", "25:00-06:00", "16:30-00:30", "aa:bb-cc:dd"]) {
    assert.throws(() => parseUtcPeakWindow(bad), /off-peak/, `expected rejection: '${bad}'`);
  }
});
