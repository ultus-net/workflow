import assert from "node:assert/strict";
import test from "node:test";

import { resolveTuiWorkspace } from "../src/cli/tui-args.js";

test("TUI workspace accepts --cwd and -c arguments", () => {
  assert.equal(resolveTuiWorkspace(["--cwd", "/tmp/project"], "/fallback"), "/tmp/project");
  assert.equal(resolveTuiWorkspace(["-c", "relative/project"], "/fallback"), "/fallback/relative/project");
  assert.equal(resolveTuiWorkspace([], "/fallback"), "/fallback");
});

test("TUI workspace rejects a missing cwd value", () => {
  assert.throws(() => resolveTuiWorkspace(["--cwd"], "/fallback"), /requires a path/);
});
