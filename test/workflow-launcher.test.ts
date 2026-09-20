import assert from "node:assert/strict";
import test from "node:test";

import {
  LAUNCHER_OPTIONS,
  cliSibling,
  parseLauncherArgs,
  resolveSelection,
} from "../src/cli/launcher-args.js";

/**
 * The `workflow` launcher selector (docs/ideas/hub-control-plane.md MVP):
 * pure surface resolution only — the verb picker never spawns in tests.
 */

test("launcher parses the surface verb and passes the rest through", () => {
  assert.deepEqual(parseLauncherArgs(["tui", "--port", "4173"]), { verb: "tui", rest: ["--port", "4173"] });
  assert.deepEqual(parseLauncherArgs(["--no-browser"]), { rest: ["--no-browser"] });
});

test("launcher rejects unknown surfaces instead of guessing", () => {
  assert.throws(() => parseLauncherArgs(["serve"]), TypeError);
  assert.throws(() => parseLauncherArgs(["WEB"]), TypeError); // verbs are exact
});

test("launcher selection accepts index or exact verb", () => {
  assert.equal(resolveSelection("1"), "web");
  assert.equal(resolveSelection("4"), "hub");
  assert.equal(resolveSelection(" settings "), "settings");
  assert.equal(resolveSelection("hub"), "hub");
  assert.equal(resolveSelection(""), undefined);
  assert.equal(resolveSelection("browser"), undefined);
  assert.equal(resolveSelection("0"), undefined);
  assert.equal(resolveSelection("5"), undefined);
});

test("every selectable option resolves", () => {
  for (const [index, option] of LAUNCHER_OPTIONS.entries()) {
    assert.equal(resolveSelection(String(index + 1)), option.verb);
  }
});

test("sibling CLI resolution: checkout uses the tsx loader on source", () => {
  const tui = cliSibling("file:///repo/src/cli/workflow.ts", "opencode-attach");
  assert.equal(tui.script, "/repo/src/cli/opencode-attach.ts");
  assert.deepEqual(tui.execArgv, ["--import", "tsx"]);
  const hub = cliSibling("file:///repo/src/cli/workflow.ts", "hub");
  assert.equal(hub.script, "/repo/src/cli/hub.ts");
  assert.deepEqual(hub.execArgv, ["--import", "tsx"]);
});

test("sibling CLI resolution: dist is a plain compiled sibling", () => {
  const tui = cliSibling("file:///repo/dist/cli/workflow.js", "opencode-attach");
  assert.equal(tui.script, "/repo/dist/cli/opencode-attach.js");
  assert.deepEqual(tui.execArgv, []);
  const hub = cliSibling("file:///repo/dist/cli/workflow.js", "hub");
  assert.equal(hub.script, "/repo/dist/cli/hub.js");
});
