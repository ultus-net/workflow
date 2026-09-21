import assert from "node:assert/strict";
import test from "node:test";

import { createSessionCompactionMonitor } from "../src/integrations/opencode-server-monitor.js";

/**
 * W082 — the hub-side session-compaction monitor (the data-lane backstop).
 * Deterministic ticks with an injected fetch and clock: the usage read rides
 * the documented `GET /api/session` entries (tokens on the session info,
 * live-verified on stock v2.0.10), the fire rides the documented compact
 * route, hysteresis re-arms only below the threshold, a sticky budget veto
 * stops firing, and every failure is recorded verbatim — never fabricated
 * as a success.
 */

interface FixtureSession {
  readonly id: string;
  readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } };
}

function sessionJson(sessions: readonly FixtureSession[]): string {
  return JSON.stringify({ data: sessions.map((session) => ({ ...session, projectID: "p", time: {} })) });
}

function usage(total: number): FixtureSession["tokens"] {
  return { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

interface HarnessOptions {
  readonly sessions: () => readonly FixtureSession[];
  readonly compactStatus?: (sessionId: string) => number;
  readonly veto?: () => string | undefined;
  readonly fetchError?: Error;
  readonly stamp?: number;
}

function harness(options: HarnessOptions): { tick: () => ReturnType<ReturnType<typeof createSessionCompactionMonitor>["tick"]>; fired: () => readonly string[] } {
  const fired: string[] = [];
  const monitor = createSessionCompactionMonitor({
    baseUrl: "http://127.0.0.1:1",
    username: "opencode",
    password: "pw",
    thresholdTokens: 1_000,
    ...(options.veto === undefined ? {} : { veto: options.veto }),
    now: () => new Date(options.stamp ?? 1_000_000),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session") && init?.method === undefined) {
        if (options.fetchError !== undefined) throw options.fetchError;
        return new Response(sessionJson(options.sessions()), { status: 200 });
      }
      if (url.includes("/compact") && init?.method === "POST") {
        const sessionId = url.split("/").at(-2)!;
        if (options.fetchError !== undefined) throw options.fetchError;
        const status = options.compactStatus?.(sessionId) ?? 200;
        if (status === 200) fired.push(sessionId);
        const body = status === 200 ? JSON.stringify({ data: { id: `msg_${sessionId}`, type: "compaction" } }) : JSON.stringify({ data: { message: "Nothing to compact yet" } });
        return new Response(body, { status });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  });
  return { tick: () => monitor.tick(), fired: () => fired };
}

test("a session over the threshold fires the documented compact route once", async () => {
  const fixture = harness({ sessions: () => [{ id: "ses_over", tokens: usage(2_000) }] });
  const result = await fixture.tick();
  assert.deepEqual(result.fired, ["ses_over"]);
  assert.equal(result.evaluated, 1);
  assert.equal(result.errors.length, 0);
});

test("hysteresis: no refire while usage stays above; re-arm below the threshold", async () => {
  let total = 2_000;
  const fixture = harness({ sessions: () => [{ id: "ses_h", tokens: usage(total) }], stamp: 1_000_000 });
  const first = await fixture.tick();
  assert.deepEqual(first.fired, ["ses_h"]);
  // Next tick (cooldown active): usage still above → skipped, never re-fired.
  const second = await fixture.tick();
  assert.deepEqual(second.fired, []);
  assert.match(second.skipped[0]!.reason, /cooling down/);
  // Compaction freed context: usage below threshold re-arms the session.
  total = 400;
  const third = await fixture.tick();
  assert.deepEqual(third.fired, []);
  assert.equal(third.skipped.length, 0);
  // Crossing again after re-arm fires once more (a fresh cooldown epoch).
  total = 2_000;
  const fourth = await fixture.tick();
  assert.deepEqual(fourth.fired, ["ses_h"]);
});

test("a sticky budget veto stops every fire and states the reason", async () => {
  const fixture = harness({
    sessions: () => [{ id: "ses_budget", tokens: usage(5_000) }],
    veto: () => "total tokens exceeded the session budget cap",
  });
  const result = await fixture.tick();
  assert.deepEqual(result.fired, []);
  assert.match(result.skipped[0]!.reason, /session-budget veto: total tokens exceeded/);
});

test("an unavailable compaction is recorded verbatim and backs off, never fabricated", async () => {
  // The honest failure shape: nothing to compact (compaction.unavailable
  // wording, non-200) — the monitor records the reason and backs off.
  const fixture = harness({
    sessions: () => [{ id: "ses_unavailable", tokens: usage(2_000) }],
    compactStatus: () => 400,
  });
  const first = await fixture.tick();
  assert.deepEqual(first.fired, []);
  assert.match(first.errors[0]!, /ses_unavailable: the gateway refused the compaction request \(400\): Nothing to compact yet/);
  // The backoff: an immediate second tick skips the retry entirely.
  const second = await fixture.tick();
  assert.match(second.skipped[0]!.reason, /cooling down/);
});

test("an upstream failure is an honest error state, never a crash or a fire", async () => {
  const fixture = harness({ sessions: () => [], fetchError: new Error("the daemon stopped") });
  const result = await fixture.tick();
  assert.equal(result.evaluated, 0);
  assert.deepEqual(result.fired, []);
  assert.match(result.errors[0]!, /the session read failed: the daemon stopped/);
});

test("a malformed session-read shape fails closed with an error, never a fire", async () => {
  const monitor = createSessionCompactionMonitor({
    baseUrl: "http://127.0.0.1:1",
    username: "opencode",
    password: "pw",
    thresholdTokens: 1_000,
    fetchImpl: (async () => new Response("{\"nope\":true}", { status: 200 })) as typeof fetch,
  });
  const result = await monitor.tick();
  assert.equal(result.evaluated, 0);
  assert.deepEqual(result.fired, []);
  assert.match(result.errors[0]!, /unexpected shape/);
});