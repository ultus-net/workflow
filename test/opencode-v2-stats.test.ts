import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenCodeV2SessionStats } from "../src/integrations/opencode-v2-stats.js";

test("parses the observed OpenCode v2 session.stats envelope", () => {
  const stats = parseOpenCodeV2SessionStats({ data: { sessions: 2, subagents: 1, prompts: 4, steps: 8, cost: 1.25, tools: { totals: { calls: 10, succeeded: 8, failed: 2, unfinished: 0 } } } });
  assert.deepEqual(stats.tools, { calls: 10, succeeded: 8, failed: 2, unfinished: 0 });
  assert.equal(stats.sessions, 2);
});

test("stats parser rejects malformed or negative counters", () => {
  assert.throws(() => parseOpenCodeV2SessionStats({ data: {} }), /tools/);
  assert.throws(() => parseOpenCodeV2SessionStats({ data: { sessions: -1, subagents: 0, prompts: 0, steps: 0, cost: 0, tools: { totals: { calls: 0, succeeded: 0, failed: 0, unfinished: 0 } } } }), /sessions/);
});