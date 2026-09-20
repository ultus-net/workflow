import assert from "node:assert/strict";
import test from "node:test";

import { acpAgentKind } from "../src/integrations/acp-runtime.js";
import {
  LAUNCHER_OPTIONS,
  cliSibling,
  parseAgentFlag,
  parseLauncherArgs,
  resolveAgentKind,
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

test("the engine axis parses --agent in both forms and strips it from downstream args", () => {
  const spaced = parseAgentFlag(["--agent", "goose", "--port", "4173"]);
  assert.equal(spaced.agent, "goose");
  assert.deepEqual(spaced.rest, ["--port", "4173"]);
  const inline = parseAgentFlag(["--agent=cline", "--no-browser"]);
  assert.equal(inline.agent, "cline");
  assert.deepEqual(inline.rest, ["--no-browser"]);
  const absent = parseAgentFlag(["--port", "4173"]);
  assert.equal(absent.agent, undefined);
  assert.deepEqual(absent.rest, ["--port", "4173"]);
});

test("the engine axis fails closed on unknown or valueless --agent", () => {
  const unknown = parseAgentFlag(["--agent", "gpt5"]);
  assert.match(unknown.error ?? "", /opencode \| goose \| cline/);
  assert.deepEqual(unknown.rest, ["--agent", "gpt5"], "the malformed argv is returned untouched");
  const valueless = parseAgentFlag(["--agent"]);
  assert.match(valueless.error ?? "", /--agent needs a value/);
});

test("an explicit --agent overrides the ambient env; absence leaves the env default", () => {
  assert.equal(resolveAgentKind("goose", "cline"), "goose");
  assert.equal(resolveAgentKind(undefined, "goose"), "goose");
  assert.equal(resolveAgentKind(undefined, "  opencode  "), "opencode");
  // An invalid env value is not the launcher's to interpret — it stays
  // undefined here and `acpAgentKind` fails closed at composition time.
  assert.equal(resolveAgentKind(undefined, "gpt5"), undefined);
  assert.equal(resolveAgentKind(undefined, undefined), undefined);
});

test("the launcher's agent-kind list stays in lockstep with the runtime's acpAgentKind", () => {
  // Drift guard: a fourth kind added to one union only must fail here.
  const previous = process.env.WORKFLOW_ACP_AGENT;
  for (const kind of ["opencode", "cline", "goose"] as const) {
    process.env.WORKFLOW_ACP_AGENT = kind;
    assert.equal(acpAgentKind(), kind);
  }
  process.env.WORKFLOW_ACP_AGENT = "gpt5";
  assert.throws(() => acpAgentKind(), /must be "opencode", "cline", or "goose"/);
  if (previous === undefined) delete process.env.WORKFLOW_ACP_AGENT;
  else process.env.WORKFLOW_ACP_AGENT = previous;
});
