import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeV2EventLog } from "../src/integrations/opencode-v2-event-log.js";

test("v2 event log appends once and deduplicates stable event ids", () => {
  const log = new OpenCodeV2EventLog();
  const event = { id: "evt-1", sessionId: "ses-1", type: "tool.ended", observedAt: "2026-09-20T00:00:00Z", payload: { b: 2, a: 1 } };
  assert.ok(log.append(event));
  assert.equal(log.append(event), undefined);
  assert.equal(log.entries().length, 1);
});

test("v2 event log fallback identity is deterministic for equivalent payload ordering", () => {
  const first = new OpenCodeV2EventLog();
  const second = new OpenCodeV2EventLog();
  const base = { sessionId: "ses-1", type: "tool.ended", observedAt: "2026-09-20T00:00:00Z" };
  const a = first.append({ ...base, payload: { a: 1, b: 2 } });
  const b = second.append({ ...base, payload: { b: 2, a: 1 } });
  assert.equal(a?.logId, b?.logId);
});

test("v2 event log preserves Workflow identity and evidence metadata", () => {
  const log = new OpenCodeV2EventLog();
  const entry = log.append(
    { id: "evt-2", sessionId: "ses-1", parentSessionId: "ses-root", agentId: "opencode", type: "tool.ended", observedAt: "2026-09-20T00:00:00Z", payload: {} },
    { taskId: "task-1", stepId: "step-1", authority: "host", result: "passed" as const },
  );
  assert.equal(entry?.taskId, "task-1");
  assert.equal(entry?.stepId, "step-1");
  assert.equal(entry?.authority, "host");
});