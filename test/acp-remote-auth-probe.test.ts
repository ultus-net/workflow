import assert from "node:assert/strict";
import test from "node:test";

import { HttpRemoteEngine } from "../src/integrations/remote-acp/engine.js";

/**
 * LIVE probe (M1): the bridge authenticates against a basic-auth-protected
 * remote OpenCode server.
 *
 * Gated: WORKFLOW_ACP_REMOTE_AUTH=1 plus WORKFLOW_ACP_REMOTE_URL (or
 * OPENCODE_SERVER_URL), OPENCODE_SERVER_PASSWORD and optional
 * OPENCODE_SERVER_USERNAME. Expects the server to actually require auth
 * (OPENCODE_SERVER_PASSWORD set on the server), so an unprotected server
 * honestly fails the unauthenticated arm. Skips without its gate.
 */

const run = process.env.WORKFLOW_ACP_REMOTE_AUTH === "1";
const url = process.env.WORKFLOW_ACP_REMOTE_URL ?? process.env.OPENCODE_SERVER_URL;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const username = process.env.OPENCODE_SERVER_USERNAME;

test("remote ACP auth probe: unauthenticated health fails, authenticated health succeeds", { skip: !run || url === undefined, timeout: 60_000 }, async () => {
  const unprotected = new HttpRemoteEngine({ baseUrl: url as string, cwd: process.cwd() });
  await assert.rejects(() => unprotected.health(), /failed \(401\)/, "the server must require authentication");

  assert.ok(password !== undefined && password !== "", "OPENCODE_SERVER_PASSWORD is required for this probe");
  const authenticated = new HttpRemoteEngine({
    baseUrl: url as string,
    cwd: process.cwd(),
    password,
    ...(username === undefined || username === "" ? {} : { username }),
  });
  const health = await authenticated.health();
  assert.equal(health.healthy, true, "authenticated health must succeed");
});
