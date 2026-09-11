import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node-pty";

test("selected TUI CLI starts in a terminal runtime and exits on q", async () => {
  const terminal = spawn(process.execPath, ["--import", "tsx", "src/cli/tui.tsx"], {
    name: "xterm",
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm" },
  });
  let output = "";
  terminal.onData((chunk) => { output += chunk; });

  await new Promise((resolve) => setTimeout(resolve, 100));
  terminal.write("q");
  const exitCode = await new Promise<number>((resolve) => terminal.onExit(({ exitCode }) => resolve(exitCode)));

  assert.equal(exitCode, 0, output);
  assert.match(output, /WORKFLOW/);
  assert.match(output, /W001/);
});
