import assert from "node:assert/strict";
import test from "node:test";

import { HttpRemoteEngine, type RemoteEngineEvent } from "../src/integrations/remote-acp/engine.js";
import { classifySseIdleHold } from "../src/integrations/probe-verdicts.js";

/**
 * LIVE probe (M1): a remote/attached OpenCode server streams a turn over SSE.
 *
 * Gated: WORKFLOW_ACP_REMOTE_SSE=1 plus WORKFLOW_ACP_REMOTE_URL (or
 * OPENCODE_SERVER_URL) and, for a protected server, OPENCODE_SERVER_PASSWORD /
 * OPENCODE_SERVER_USERNAME. Skips without its gate, per the probe rules in
 * docs/HOST_ADAPTERS.md.
 *
 * The second test is the optional idle arm, gated separately on
 * WORKFLOW_ACP_REMOTE_SSE_IDLE=1: it holds one `/api/event` subscription open
 * through a 4-minute window with no events and fails only if the ingress drops
 * the stream or silently resumes it. Verdict of record for the arm:
 * docs/PROBE_VERDICTS.json row `acp-remote-sse-idle` (pending).
 *
 * The arm's survival decision is NOT inline here: it is
 * `classifySseIdleHold` (src/integrations/probe-verdicts.ts), shared with
 * test/probe-verdict-sse-idle.test.ts. This test is the only place the
 * *evidence* is gathered (a real 240s hold against a real ingress, which no
 * normal run pays for); the conditions that turn those facts into a verdict
 * are pinned by the fast suite, so a weakened check cannot hide behind the
 * gate until the next four-minute live run.
 *
 * Advisory only: this probe proves the transport, not enforcement. Enforcement
 * requires the PERMISSION and RULE-CONFIG probes (spec section 10).
 */

const run = process.env.WORKFLOW_ACP_REMOTE_SSE === "1";
const runIdle = process.env.WORKFLOW_ACP_REMOTE_SSE_IDLE === "1";
const url = process.env.WORKFLOW_ACP_REMOTE_URL ?? process.env.OPENCODE_SERVER_URL;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const username = process.env.OPENCODE_SERVER_USERNAME;

/** The ingress idle window the stream must survive: 4 minutes, no events. */
const IDLE_WINDOW_MS = 240_000;
/** Budget for the engine to open the event stream before the window starts. */
const SETUP_MS = 30_000;

/** The gated remote engine, with the operator credentials when present. */
function remoteEngine(cwd: string, fetchImpl?: typeof fetch): HttpRemoteEngine {
  return new HttpRemoteEngine({
    baseUrl: url as string,
    cwd,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...(password === undefined || password === "" ? {} : { password }),
    ...(username === undefined || username === "" ? {} : { username }),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("remote ACP SSE probe: a live turn streams message parts and reaches a session status", { skip: !run || url === undefined, timeout: 180_000 }, async (t) => {
  const cwd = process.cwd();
  const engine = remoteEngine(cwd);

  const health = await engine.health();
  assert.equal(health.healthy, true, "remote server must report healthy");

  const session = await engine.createSession({ cwd, title: "workflow remote acp sse probe" });
  const controller = new AbortController();
  t.after(() => controller.abort());

  const events: RemoteEngineEvent[] = [];
  const pump = (async () => {
    for await (const event of engine.events({ cwd, signal: controller.signal })) {
      events.push(event);
      if (event.type === "session.status") return;
    }
  })();

  await engine.prompt({ sessionId: session.id, cwd, text: "Reply with the single word: ready" });
  await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 120_000))]);

  assert.ok(
    events.some((event) => event.type === "message.part.updated" || event.type === "message.part.delta"),
    "expected at least one message-part event over SSE",
  );
  assert.ok(events.some((event) => event.type === "session.status"), "expected a session status event");
});

test("remote ACP SSE idle probe: one event stream survives a 240s no-event window", {
  skip: !runIdle || url === undefined,
  timeout: IDLE_WINDOW_MS + 60_000,
}, async (t) => {
  const cwd = process.cwd();

  // Every `text/event-stream` response the engine gets back is one SSE
  // subscription — the JSON routes never answer with that content type. This
  // probe opens the stream once and never re-opens it, so a second
  // subscription can only be an engine-side (silent) resume. `engine.events()`
  // has no reconnect today, so this also pins that a future one stays visible
  // here instead of quietly swallowing the gap.
  let subscriptions = 0;
  const instrumented: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) subscriptions += 1;
    return response;
  };

  const engine = remoteEngine(cwd, instrumented);
  const health = await engine.health();
  assert.equal(health.healthy, true, "remote server must report healthy");

  const controller = new AbortController();
  t.after(() => controller.abort());

  const delivered: RemoteEngineEvent[] = [];
  let drop: string | undefined;
  // Deliberately not awaited: on a surviving stream this never settles before
  // the window closes, which is exactly the evidence the arm is after.
  void (async () => {
    try {
      for await (const event of engine.events({ cwd, signal: controller.signal })) delivered.push(event);
      drop = "the event stream ended";
    } catch (error) {
      drop = `the event stream errored: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();

  // Establish liveness before the window: survival is only meaningful for a
  // subscription that actually opened, so a stream that never arrived is a
  // setup failure, never a quiet pass. This pre-check exists to fail fast
  // instead of holding a four-minute window against a stream that never
  // opened; the same fact is also classified (`never-opened`) below, so the
  // verdict can never be a survival without a subscription.
  const setupDeadline = Date.now() + SETUP_MS;
  while (subscriptions === 0 && Date.now() < setupDeadline) await sleep(100);
  assert.ok(subscriptions > 0, "the engine never received an SSE subscription (no text/event-stream response)");
  const openedBefore = subscriptions;

  const windowStart = Date.now();
  await sleep(IDLE_WINDOW_MS);
  const heldMs = Date.now() - windowStart;

  t.diagnostic(`idle window: ${Math.round(heldMs / 1000)}s held, ${delivered.length} event(s) delivered, ${subscriptions} subscription(s)`);

  // One decision, shared with the fast suite: probe integrity (the hold was
  // real), then a mid-window drop, then a silent resume. Events delivered
  // during the window are reported honestly, never banked as a clean hold.
  const verdict = classifySseIdleHold({
    heldMs,
    idleWindowMs: IDLE_WINDOW_MS,
    delivered: delivered.length,
    subscriptions,
    openedBefore,
    drop,
  });
  if (!verdict.eventFree) {
    t.diagnostic(`the window was NOT event-free (${delivered.map((event) => event.type).join(", ")}) — the idle premise is only partially exercised`);
  }
  assert.ok(verdict.survived, verdict.reason);
});
