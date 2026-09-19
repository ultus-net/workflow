import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isPermissionAsked } from "../src/integrations/remote-acp/engine.js";
import { collectEvents, remoteProbe } from "./acp-remote-probe-helpers.js";

/**
 * LIVE probe (M2, pivotal): a rejected permission is honored pre-mutation.
 *
 * Gated: WORKFLOW_ACP_REMOTE_PERMISSION=1 plus WORKFLOW_ACP_REMOTE_URL (or
 * OPENCODE_SERVER_URL) and credentials. The remote ruleset MUST be pinned to
 * `ask` for edit/bash, otherwise this probe fails with "expected a
 * permission.asked event" — which is the honest signal that the surface cannot
 * claim `enforced`. Skips without its gate.
 */

const run = process.env.WORKFLOW_ACP_REMOTE_PERMISSION === "1";
const probe = remoteProbe();

test("remote ACP permission probe: a reject is honored before the mutation", { skip: !run || probe === undefined, timeout: 180_000 }, async (t) => {
  const { engine, cwd } = probe!;
  const dir = mkdtempSync(join(tmpdir(), "wf-remote-probe-"));
  const canary = join(dir, "canary.txt");
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  });
  const collector = collectEvents(engine, cwd, controller.signal);

  const session = await engine.createSession({ cwd, title: "workflow remote permission probe" });
  await engine.prompt({ sessionId: session.id, cwd, text: `Create a file at ${canary} containing the word canary.` });

  const asked = await collector.waitFor((event) => event.type === "permission.asked", 90_000);
  assert.ok(asked, "expected a permission.asked event; pin the remote ruleset to ask for edit/bash before claiming enforcement");
  if (isPermissionAsked(asked)) {
    await engine.replyPermission({ sessionId: session.id, requestId: asked.properties.id, reply: "reject", cwd });
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(existsSync(canary), false, "a rejected permission must not produce the mutation");
});
