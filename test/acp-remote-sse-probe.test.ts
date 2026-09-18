import assert from "node:assert/strict";
import test from "node:test";

import { HttpRemoteEngine, type RemoteEngineEvent } from "../src/integrations/remote-acp/engine.js";

/**
 * LIVE probe (M1): a remote/attached OpenCode server streams a turn over SSE.
 *
 * Gated: WORKFLOW_ACP_REMOTE_SSE=1 plus WORKFLOW_ACP_REMOTE_URL (or
 * OPENCODE_SERVER_URL) and, for a protected server, OPENCODE_SERVER_PASSWORD /
 * OPENCODE_SERVER_USERNAME. Skips without its gate, per the probe rules in
 * docs/HOST_ADAPTERS.md.
 *
 * Advisory only: this probe proves the transport, not enforcement. Enforcement
 * requires the PERMISSION and RULE-CONFIG probes (spec section 10).
 */

const run = process.env.WORKFLOW_ACP_REMOTE_SSE === "1";
const url = process.env.WORKFLOW_ACP_REMOTE_URL ?? process.env.OPENCODE_SERVER_URL;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const username = process.env.OPENCODE_SERVER_USERNAME;

test("remote ACP SSE probe: a live turn streams message parts and reaches a session status", { skip: !run || url === undefined, timeout: 180_000 }, async (t) => {
  const cwd = process.cwd();
  const engine = new HttpRemoteEngine({
    baseUrl: url as string,
    cwd,
    ...(password === undefined || password === "" ? {} : { password }),
    ...(username === undefined || username === "" ? {} : { username }),
  });

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
