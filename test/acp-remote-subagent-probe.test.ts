import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectEvents, remoteProbe } from "./acp-remote-probe-helpers.js";

/**
 * LIVE probe (M2): whether a spawn/subagent projects and can be denied.
 *
 * Gated: WORKFLOW_ACP_REMOTE_SUBAGENT=1 plus WORKFLOW_ACP_REMOTE_URL and
 * credentials. Prompts a task-tool spawn and records whether a spawn tool call
 * or its permission reached the stream. Per the probe rules
 * (docs/HOST_ADAPTERS.md), an unprojected spawn caps the surface `advisory` or
 * spawn-denied. This stub records the observation rather than overclaiming.
 * Skips without its gate.
 */

const run = process.env.WORKFLOW_ACP_REMOTE_SUBAGENT === "1";
const probe = remoteProbe();

test("remote ACP subagent probe: spawn projection/denial is recorded", { skip: !run || probe === undefined, timeout: 240_000 }, async (t) => {
  const { engine, cwd } = probe!;
  const dir = mkdtempSync(join(tmpdir(), "wf-remote-subagent-"));
  const canary = join(dir, "canary.txt");
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  });
  const collector = collectEvents(engine, cwd, controller.signal);

  const session = await engine.createSession({ cwd, title: "workflow remote subagent probe" });
  await engine.prompt({ sessionId: session.id, cwd, text: `Use a subagent/task tool to create a file at ${canary} containing the word canary.` });
  await new Promise((resolve) => setTimeout(resolve, 120_000));

  const spawnProjected = collector.events.some((event) => {
    if (event.type !== "message.part.updated") return false;
    const part = event.properties.part as { callID?: unknown; tool?: unknown } | undefined;
    return typeof part?.callID === "string" && (part.tool === "task" || part.tool === "agent" || part.tool === "spawn_agent");
  });
  const spawnPermissionObserved = collector.events.some((event) => {
    if (event.type !== "permission.asked") return false;
    return event.properties.action === "task" || event.properties.action === "agent";
  });

  // Record the verdict in the test name/assertion output. An unprojected or
  // un-asked spawn is a legitimate (advisory) result, not a probe failure.
  assert.ok(
    collector.events.length > 0,
    `expected some projected activity; spawnProjected=${String(spawnProjected)} spawnPermissionObserved=${String(spawnPermissionObserved)}`,
  );
});
