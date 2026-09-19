import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectEvents, hasPermissionRequest, remoteProbe } from "./acp-remote-probe-helpers.js";

/**
 * LIVE probe (M2): a permissive remote ruleset bypasses interception.
 *
 * Gated: WORKFLOW_ACP_REMOTE_BYPASS=1 plus WORKFLOW_ACP_REMOTE_URL and
 * credentials. Configure the remote to `allow` a mutating tool, then this
 * probe asserts NO permission request is observed — the honest reason a
 * permissive remote can only be advertised `advisory`. If an ask appears the
 * probe fails (the config was not actually permissive). Skips without its gate.
 */

const run = process.env.WORKFLOW_ACP_REMOTE_BYPASS === "1";
const probe = remoteProbe();

test("remote ACP bypass probe: an allow ruleset emits no permission ask", { skip: !run || probe === undefined, timeout: 180_000 }, async (t) => {
  const { engine, cwd } = probe!;
  const dir = mkdtempSync(join(tmpdir(), "wf-remote-bypass-"));
  const canary = join(dir, "canary.txt");
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  });
  const collector = collectEvents(engine, cwd, controller.signal);

  const session = await engine.createSession({ cwd, title: "workflow remote bypass probe" });
  await engine.prompt({ sessionId: session.id, cwd, text: `Create a file at ${canary} containing the word canary.` });
  await new Promise((resolve) => setTimeout(resolve, 30_000));

  assert.equal(
    hasPermissionRequest(collector.events),
    false,
    "with an allow ruleset no permission.asked should appear; an ask means the config was not permissive and this probe is misconfigured",
  );
});
