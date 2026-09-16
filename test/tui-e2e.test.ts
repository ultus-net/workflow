import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn as spawnPty } from "node-pty";

/**
 * Real-terminal e2e for the universal TUI surface. Spawns the entry-seam
 * fixture (OSC 11 detection before render, then WorkflowTui over a live
 * session) inside a pseudo-terminal, answers the background query like a
 * terminal emulator, and drives it with the exact byte sequences a real
 * terminal sends. This is the layer that catches input-pipeline breakage
 * (stdin starvation, escape-sequence handling) that component tests over
 * ink-testing-library cannot see.
 */

const OSC_QUERY = "\x1b]11;?\x07";
// Dark background [16,20,28] → white wash at 12% → #2d3037.
const OSC_RESPONSE = "\x1b]11;rgb:1010/1414/1c1c\x1b\\";
const TINT_TRUECOLOR = "\x1b[48;2;45;48;55m";
// Real terminal byte sequences (what a terminal emulator actually sends).
const CTRL_UP = "\x1b[1;5A";
const CTRL_C = "\x03";

function stripAnsi(output: string): string {
  // Stripping terminal control sequences requires matching control characters —
  // the exact thing this helper exists to remove. Scoped disable, no workaround.
  /* eslint-disable no-control-regex */
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f]/g, "");
  /* eslint-enable no-control-regex */
}

// Generous deadlines: the suite runs many PTY-spawning tests in parallel, so
// tsx startup and frame renders can be far slower than a standalone run.
const STEP_TIMEOUT_MS = 30_000;

test("TUI e2e over a real PTY: typing, turn lifecycle, stay-open menu, history recall", { timeout: 150_000 }, async (t) => {
  const terminal = spawnPty(process.execPath, ["--import", "tsx", "test/fixtures/tui-e2e-surface.mjs"], {
    name: "xterm-256color",
    cols: 100,
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", WORKFLOW_AUTOHUB: "0" },
  });
  t.after(() => { try { terminal.kill(); } catch { /* PTY cleanup is best-effort */ } });

  let raw = "";
  let oscAnswered = false;
  terminal.onData((chunk) => {
    raw += chunk;
    if (!oscAnswered && raw.includes(OSC_QUERY)) {
      oscAnswered = true;
      terminal.write(OSC_RESPONSE);
    }
  });

  const since = (offset: number): string => stripAnsi(raw.slice(offset));
  const plain = (): string => stripAnsi(raw);
  const lastLineWith = (needle: string): string => {
    const lines = plain().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.includes(needle)) return lines[index]!;
    }
    return "";
  };
  const waitFor = async (condition: () => boolean, what: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !condition()) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(condition(), `timed out waiting for: ${what}\n--- output tail ---\n${plain().slice(-1_500)}`);
  };

  // 1. Boot: the surface queries the terminal background, applies the derived
  //    tint as the block composer, and leaks no OSC bytes into the interface.
  await waitFor(() => lastLineWith("What do you want to build?").length > 0, "composer placeholder");
  assert.ok(oscAnswered, "the surface must send the OSC 11 background query");
  assert.ok(raw.includes(TINT_TRUECOLOR), "the composer must render the OSC-derived tint");
  assert.doesNotMatch(lastLineWith("What do you want to build?"), /│/, "block composer has no border when the tint is active");
  assert.ok(!plain().includes("]11;rgb:"), "no OSC payload may leak into the interface");

  // 2. Typing reaches the composer (the reported regression).
  terminal.write("verify the graph");
  await waitFor(() => plain().includes("❯ verify the graph"), "composer echo of typed prompt");

  // 3. Submitting drives the full turn lifecycle.
  terminal.write("\r");
  await waitFor(() => plain().includes("[running]"), "running indicator");
  await waitFor(() => plain().includes("e2e assistant reply: verify the graph"), "assistant reply");
  await waitFor(() => plain().includes("e2e turn complete"), "turn completion");

  // 4. The options menu opens and STAYS OPEN while digits cycle options.
  terminal.write("/");
  await waitFor(() => plain().includes("Workflow options"), "options menu");
  terminal.write("1");
  await waitFor(() => plain().includes("Mode: Learn to Code"), "first mode cycle");
  const afterFirstCycle = raw.length;
  terminal.write("1");
  await waitFor(() => since(afterFirstCycle).includes("Mode: Socratic Tutor"), "second mode cycle");
  assert.ok(since(afterFirstCycle).includes("Workflow options"), "the menu must stay open while cycling");

  // 5. q closes the menu and the keys hint returns.
  terminal.write("q");
  const afterQ = raw.length;
  await waitFor(() => since(afterQ).includes("keys: / menu"), "menu closed, hint restored");

  // 6. Real Ctrl+Up recalls the submitted prompt.
  const beforeRecall = raw.length;
  terminal.write(CTRL_UP);
  await waitFor(() => since(beforeRecall).includes("❯ verify the graph"), "history recall restores the prompt");

  // 7. Ctrl+C exits cleanly when no turn is running.
  terminal.write(CTRL_C);
  const { exitCode } = await new Promise<{ exitCode: number }>((resolve) => terminal.onExit((event) => resolve(event)));
  assert.equal(exitCode, 0, "the surface must exit cleanly on Ctrl+C");
});

test("TUI e2e: a terminal that never answers OSC 11 keeps typing alive and falls back to the bordered composer", { timeout: 150_000 }, async (t) => {
  // No OSC responder: detection must time out fail-soft, leave stdin
  // readable for Ink, and render the bordered composer fallback.
  const terminal = spawnPty(process.execPath, ["--import", "tsx", "test/fixtures/tui-e2e-surface.mjs"], {
    name: "xterm-256color",
    cols: 100,
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", WORKFLOW_AUTOHUB: "0" },
  });
  t.after(() => { try { terminal.kill(); } catch { /* PTY cleanup is best-effort */ } });

  let raw = "";
  terminal.onData((chunk) => { raw += chunk; });

  const plain = (): string => stripAnsi(raw);
  const lastLineWith = (needle: string): string => {
    const lines = plain().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]!.includes(needle)) return lines[index]!;
    }
    return "";
  };
  const waitFor = async (condition: () => boolean, what: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !condition()) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(condition(), `timed out waiting for: ${what}\n--- output tail ---\n${plain().slice(-1_500)}`);
  };

  // 1. Detection timed out (no tint) and the composer fell back to bordered.
  await waitFor(() => lastLineWith("What do you want to build?").length > 0, "composer placeholder");
  assert.match(lastLineWith("What do you want to build?"), /│/, "without a tint the composer must keep its border frame");
  assert.ok(!raw.includes(TINT_TRUECOLOR), "no tint may render when the terminal does not answer");

  // 2. Typing still works after the timeout path.
  terminal.write("still typing");
  await waitFor(() => plain().includes("❯ still typing"), "composer echo after detection timeout");

  // 3. Arrows navigate the menu without closing it (the empty-input ordering
  //    regression: arrow keys arrive with an empty input string). `/` only
  //    opens the menu on an empty composer, so clear the prompt first — the
  //    same flow a real operator uses.
  terminal.write("\x1b");
  const afterClear = raw.length;
  await waitFor(() => stripAnsi(raw.slice(afterClear)).includes("What do you want to build?"), "prompt cleared");
  terminal.write("/");
  await waitFor(() => plain().includes("Workflow options"), "options menu");
  terminal.write("\x1b[B\x1b[B");
  await waitFor(() => plain().includes("❯ 3 Build"), "arrow keys move the menu cursor");
  assert.ok(plain().includes("Workflow options"), "the menu must stay open while navigating");

  // 4. Esc closes the menu.
  terminal.write("\x1b");
  const afterEsc = raw.length;
  await waitFor(() => stripAnsi(raw.slice(afterEsc)).includes("keys: / menu"), "menu closed via Esc");

  // 5. Ctrl+C exits cleanly.
  terminal.write(CTRL_C);
  const { exitCode } = await new Promise<{ exitCode: number }>((resolve) => terminal.onExit((event) => resolve(event)));
  assert.equal(exitCode, 0, "the surface must exit cleanly on Ctrl+C");
});
