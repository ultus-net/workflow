import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { meteredOpencodeConfig } from "../src/integrations/opencode-agent-config.js";
import { normalizeSettings } from "../src/integrations/workflow-settings.js";
import { resolveDaemonAutoCompact, resolveDaemonAutoCompactAtTokens } from "../src/cli/opencode-server.js";

/**
 * W082 — the config-side automatic compaction trigger. The deterministic
 * decision recorded in §9: the ACP lane auto-compacts exactly when the
 * model's compaction config enables it, so the hub-owned trigger IS the
 * hub-written config — an operator opt-in (`agents.<id>.autoCompact`,
 * default off) that composes `compaction: { auto: true }` into
 * `meteredOpencodeConfig`, consumed by both the ACP subprocess and the
 * topology server. No plugin hook (explicitly excluded by W082), no
 * prompt-side loop, no Workflow-owned poller: the runtime's own documented
 * threshold fires, and every compaction turn stays a metered model turn
 * under the W045 budget guard.
 */

test("the autoCompact setting normalizes fail-closed and persists an explicit boolean", () => {
  const armed = normalizeSettings({ agents: { opencode: { autoCompact: true } } });
  assert.equal(armed.agents.opencode?.autoCompact, true);

  // An explicit false persists as the operator's choice (an uncheck can
  // stick through the per-key merge); only === true arms anything.
  const off = normalizeSettings({ agents: { opencode: { autoCompact: false } } });
  assert.equal(off.agents.opencode?.autoCompact, false);

  // Non-booleans are dropped fail-closed — never guessed into an armed state.
  const garbage = normalizeSettings({ agents: { opencode: { autoCompact: "yes" } } });
  assert.equal(garbage.agents.opencode?.autoCompact, undefined);

  // An autoCompact-only entry survives normalization (it is a real choice).
  assert.ok(armed.agents.opencode !== undefined);
  const only = normalizeSettings({ agents: { opencode: { autoCompact: false } } });
  assert.deepEqual(only.agents.opencode, { autoCompact: false });
});

test("meteredOpencodeConfig composes the compaction block only on an explicit opt-in", () => {
  const armed = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", autoCompact: true });
  assert.deepEqual(armed.compaction, { auto: true }, "the hub-written config carries the documented compaction block");

  // Absent (and explicitly false) compose NOTHING — the ambient runtime
  // defaults apply exactly as before the option existed. No invented keys.
  const untouched = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999" });
  assert.equal("compaction" in untouched, false);
  const off = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", autoCompact: false });
  assert.equal("compaction" in off, false);

  // The block rides beside the existing hub-owned surface, never replacing it.
  const full = meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61999", autoCompact: true });
  assert.deepEqual(full.permission, { edit: "ask", bash: "ask", task: "ask" });
});

test("the topology daemon resolves the operator autoCompact preference fail-soft", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wf-autocompact-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-autocompact-ws-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  // No settings at all → the honest default (off), never a throw.
  assert.equal(resolveDaemonAutoCompact(workspace), false);
  assert.equal(resolveDaemonAutoCompactAtTokens(workspace), undefined, "the monitor never invents a threshold");

  // Global setting arms; the workspace overlay wins over the global doc.
  mkdirSync(join(home, ".config", "workflow"), { recursive: true });
  writeFileSync(join(home, ".config", "workflow", "settings.json"), JSON.stringify({ agents: { opencode: { autoCompact: true } } }));
  assert.equal(resolveDaemonAutoCompact(workspace), true);

  mkdirSync(join(workspace, ".workflow"), { recursive: true });
  writeFileSync(join(workspace, ".workflow", "settings.json"), JSON.stringify({ agents: { opencode: { autoCompact: false } } }));
  assert.equal(resolveDaemonAutoCompact(workspace), false, "workspace overlay wins per key");

  // The monitor threshold: a positive integer only — malformed values leave
  // the monitor off, never a guessed limit.
  writeFileSync(join(home, ".config", "workflow", "settings.json"), JSON.stringify({ agents: { opencode: { autoCompactAtTokens: 150_000 } } }));
  assert.equal(resolveDaemonAutoCompactAtTokens(workspace), 150_000);
  writeFileSync(join(home, ".config", "workflow", "settings.json"), JSON.stringify({ agents: { opencode: { autoCompactAtTokens: -5 } } }));
  assert.equal(resolveDaemonAutoCompactAtTokens(workspace), undefined);
  writeFileSync(join(home, ".config", "workflow", "settings.json"), JSON.stringify({ agents: { opencode: { autoCompactAtTokens: "huge" } } }));
  assert.equal(resolveDaemonAutoCompactAtTokens(workspace), undefined);

  // An unreadable settings document degrades to off — an opt-in trigger must
  // not refuse the topology over a preference read.
  mkdirSync(join(home, ".config", "workflow"), { recursive: true });
  writeFileSync(join(home, ".config", "workflow", "settings.json"), "{corrupt");
  assert.equal(resolveDaemonAutoCompact(workspace), false);
  assert.equal(resolveDaemonAutoCompactAtTokens(workspace), undefined);
});