import assert from "node:assert/strict";
import test from "node:test";

import { consumeOpenCodeV2EventStream, OpenCodeV2EventLog } from "../src/integrations/opencode-v2-event-log.js";

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

test("v2 SSE consumer parses event frames and deduplicates replay", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('id: e1\ndata: {"id":"e1","type":"tool.ended","properties":{"sessionID":"ses-1"}}\n\n'));
      controller.enqueue(new TextEncoder().encode('id: e1\ndata: {"type":"tool.ended","properties":{"sessionID":"ses-1"}}\n\n'));
      controller.close();
    },
  });
  const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const log = new OpenCodeV2EventLog();
  assert.equal(await consumeOpenCodeV2EventStream(response, log, () => "2026-09-20T00:00:00Z"), 1);
  // The second frame is a replay with the same payload id; it is not appended.
  assert.equal(log.entries().length, 1);
});

test("v2 SSE consumer reads the live `data` envelope (payload under data, not properties)", async () => {
  // The live plane (2.0.10) wraps the payload under `data`; before the fix the
  // session id never resolved and every event was silently dropped.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"id":"evt_1","created":1,"type":"session.tool.called","location":{"directory":"/workspace"},'
        + '"data":{"sessionID":"ses-9","assistantMessageID":"m1","id":"call_1","name":"read"}}\n\n',
      ));
      controller.close();
    },
  });
  const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const log = new OpenCodeV2EventLog();
  assert.equal(await consumeOpenCodeV2EventStream(response, log, () => "2026-09-20T00:00:00Z"), 1);
  assert.equal(log.entries()[0]?.sessionId, "ses-9");
  assert.equal(log.entries()[0]?.type, "session.tool.called");
});
