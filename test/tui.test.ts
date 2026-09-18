import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { spawn as spawnPty } from "node-pty";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  WorkflowTui,
  hostCapabilities,
  taskId,
  type WorkflowTask,
  type CodingSessionDriver,
} from "../src/index.js";
import { blendTerminalTint, detectTerminalBackground } from "../src/ui/terminal-theme.js";

// The monitor-mode TUI polls every second while mounted, so a view leaked by
// a failing assertion would keep the test process alive past its results.
// Unmount everything after each test; Ink's unmount is idempotent.
afterEach(() => cleanup());

test("terminal tint blends a subtle wash derived from the terminal's own background", () => {
  // Dark background: white at 12% alpha over black.
  assert.equal(blendTerminalTint([0, 0, 0]), "#1f1f1f");
  // Light background: black at 4% alpha over white.
  assert.equal(blendTerminalTint([255, 255, 255]), "#f5f5f5");
});

test("OSC 11 background detection is fail-soft: a hex tint or undefined, never a hang", async () => {
  // Piped CI stdin resolves undefined; an interactive terminal that answers
  // OSC 11 yields a hex tint. Both are valid; anything else (or a timeout
  // longer than the query window) is a defect.
  const tint = await detectTerminalBackground();
  assert.ok(tint === undefined || /^#[0-9a-f]{6}$/.test(tint), `unexpected tint: ${String(tint)}`);
});

test("OSC 11 handshake resolves a tint through a real PTY terminal", { timeout: 15_000 }, async (t) => {
  // Covers the TTY path end-to-end: raw-mode query over a pseudo-terminal, a
  // terminal emulator answering with its background, parser + blend back to
  // a hex tint. The fake background 1e1e/1e1e/2222 normalizes to [30,30,34],
  // which blends (white @ 12%) to #39393d.
  const probe = `
import { detectTerminalBackground } from "./src/ui/terminal-theme.js";
const tint = await detectTerminalBackground();
process.stdout.write("TINT=" + String(tint) + "\\n");
process.exit(0);
`;
  const terminal = spawnPty(process.execPath, ["--import", "tsx", "-e", probe], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
  });
  t.after(() => { try { terminal.kill(); } catch { /* PTY cleanup is best-effort */ } });
  let output = "";
  terminal.onData((chunk) => {
    output += chunk;
    if (chunk.includes("\x1b]11;?\x07")) {
      terminal.write("\x1b]11;rgb:1e1e/1e1e/2222\x1b\\");
    }
  });
  await new Promise<number>((resolveExit) => terminal.onExit(({ exitCode }) => resolveExit(exitCode)));
  const tint = output.split("\n").find((line) => line.includes("TINT="))?.replace(/^.*TINT=/, "").trim();
  assert.equal(tint, "#39393d", `probe output:\n${output}`);
});

test("composer renders the block style with a terminal-derived tint and the bordered fallback without one", () => {
  const driver: CodingSessionDriver = { start: async () => undefined, cancel: async () => undefined };
  const application = new WorkflowApplication(new TaskGraph([]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));

  const bordered = render(React.createElement(WorkflowTui, { application, session: new WorkflowCodingSession(driver) }));
  const borderedRow = (bordered.lastFrame() ?? "").split("\n").find((line) => line.includes("❯")) ?? "";
  assert.match(borderedRow, /│/, "the fallback composer keeps its border frame");
  assert.match(borderedRow, /What do you want to build\?/);
  bordered.unmount();

  const block = render(React.createElement(WorkflowTui, {
    application,
    session: new WorkflowCodingSession(driver),
    composerBackground: "#1f1f1f",
  }));
  const blockRow = (block.lastFrame() ?? "").split("\n").find((line) => line.includes("❯")) ?? "";
  assert.doesNotMatch(blockRow, /│/, "the block composer has no border — the terminal-derived tint is the frame");
  assert.match(blockRow, /What do you want to build\?/);
  block.unmount();
});

test("legacy Ink projection keeps Workflow status compact and diagnostics secondary", async () => {
  const tasks: WorkflowTask[] = [{
    id: taskId("A"),
    title: "First task",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  }];
  const application = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  const view = render(React.createElement(WorkflowTui, { application }));

  assert.match(view.lastFrame() ?? "", /Workflow.*ENFORCED.*native/);
  assert.match(view.lastFrame() ?? "", /1 ready/);
  assert.doesNotMatch(view.lastFrame() ?? "", /\bTASKS\b|\bEVIDENCE\b|\bHISTORY\b/);

  view.stdin.write("\u0017");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(view.lastFrame() ?? "", /A\s+READY\s+First task/);
  view.unmount();
});

test("legacy Ink projection keeps its composition bounded", () => {
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
  const view = render(React.createElement(WorkflowTui, { application }));

  const lines = (view.lastFrame() ?? "").split("\n");
  const contentWidths = lines.map((line) => line.trimEnd().length - line.search(/\S|$/));
  assert.ok(contentWidths.every((width) => width <= 68), `expected a 68-column composition:\n${lines.join("\n")}`);
  view.unmount();
});

test("Ink projection pulls the terminal theme: allowlisted ANSI-slot colors, never fixed RGB or backgrounds", () => {
  const source = readFileSync(new URL("../src/ui/tui.tsx", import.meta.url), "utf8");
  // Foreground accents must be chalk basic-16 names — Ink routes those to the
  // themeable ANSI slots (\e[36m …) the user's terminal remaps, and NO_COLOR
  // strips them for free because chalk drops to level 0. Hex/rgb/ansi256 would
  // override the theme. Both prop forms are scanned (color="…" and the
  // conditional-spread form { color: "…" }) so neither can smuggle a literal.
  const themeSlots = new Set(["cyan", "green", "yellow", "red", "gray"]);
  const used = [
    ...source.matchAll(/\b(?:color|borderColor)\s*=\s*"([^"]*)"/g),
    ...source.matchAll(/\b(?:color|borderColor)\s*:\s*"([^"]*)"/g),
  ].map((match) => match[1] ?? "");
  for (const value of used) {
    assert.ok(themeSlots.has(value), `color "${value}" is not a themeable ANSI-slot name`);
  }
  // Expression forms (color={helper()}) escape the literal scan, so the theme
  // must also be pinned at the source: no fixed-RGB color values may exist
  // anywhere in the projection, and every accent helper routes to the pinned
  // constants above.
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, "hex color values would override the terminal theme");
  assert.doesNotMatch(source, /\brgb\(/, "rgb() values would override the terminal theme");
  assert.doesNotMatch(source, /\bansi256\(/, "ansi256() values would override the terminal theme");
  // Backgrounds: the only permitted background is the OSC 11 terminal-derived
  // composer tint (src/ui/terminal-theme.ts) — sampled from the user's own
  // terminal, never a hardcoded value. Any other background assignment fights
  // the theme and must fail here.
  assert.doesNotMatch(source, /\b(?:backgroundColor|bgColor)\s*=\s*["'#]/);
  const backgrounds = [...source.matchAll(/\b(?:backgroundColor|bgColor)\s*:\s*([^,}\n]+)/g)].map((match) => match[1]?.trim() ?? "");
  for (const value of backgrounds) {
    assert.equal(value, "composerBackground", `background "${value}" must come from terminal detection, not a literal`);
  }
  // The accent constants themselves stay pinned to theme slots.
  assert.match(source, /const ACCENT_INTERACTIVE = "cyan"/);
  assert.match(source, /const ACCENT_SUCCESS = "green"/);
  assert.match(source, /const ACCENT_WARNING = "yellow"/);
  assert.match(source, /const ACCENT_FAILURE = "red"/);
  assert.match(source, /const ACCENT_FRAME = "gray"/);
  // Accent helpers must only return the pinned constants (or undefined).
  const helperReturns = [...source.matchAll(/return (ACCENT_[A-Z]+)/g)].map((match) => match[1] ?? "");
  for (const value of helperReturns) {
    assert.ok(["ACCENT_INTERACTIVE", "ACCENT_SUCCESS", "ACCENT_WARNING", "ACCENT_FAILURE", "ACCENT_FRAME"].includes(value), `accent helper returns unpinned ${value}`);
  }
});

test("legacy Ink projection renders conversation and tool activity", async () => {
  let submitted = "";
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      submitted = prompt;
      emit({ type: "status", status: "planning" });
      emit({ type: "assistant", text: "Inspecting repository" });
      emit({ type: "tool-proposal", tool: "read_files", subjects: ["README.md"] });
      emit({ type: "tool-outcome", tool: "read_files", outcome: "succeeded" });
      emit({ type: "completed", result: "Repository inspected" });
    },
    async cancel() {},
  };
  const application = new WorkflowApplication(new TaskGraph([]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application, session }));

  assert.match(view.lastFrame() ?? "", /What do you want to build\?/);
  view.stdin.write("Inspect README");
  await waitForFrame(view, /❯ Inspect README/);
  assert.match(view.lastFrame() ?? "", /❯ Inspect README/);
  view.stdin.write("\r");
  await waitForFrame(view, /completed.*Repository inspected/);

  assert.equal(submitted, "Inspect README");
  assert.match(view.lastFrame() ?? "", /You\s+Inspect README/);
  assert.match(view.lastFrame() ?? "", /Cline\s+Inspecting repository/);
  assert.match(view.lastFrame() ?? "", /\[tool\]\s+read_files\s+README\.md/);
  assert.match(view.lastFrame() ?? "", /\[ok\]\s+read_files/);
  assert.match(view.lastFrame() ?? "", /completed.*Repository inspected/);
  view.unmount();
});

test("TUI renders assistant activity with the composed driver label", async () => {
  const driver: CodingSessionDriver = {
    async start(_prompt, emit) {
      emit({ type: "assistant", text: "ACP response" });
      emit({ type: "completed", result: "done" });
    },
    async cancel() {},
  };
  const application = new WorkflowApplication(new TaskGraph([]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application, session, assistantLabel: "acp" }));

  view.stdin.write("Inspect repository");
  view.stdin.write("\r");
  await waitForFrame(view, /acp\s+ACP response/);

  assert.match(view.lastFrame() ?? "", /acp\s+ACP response/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Cline\s+ACP response/);
  view.unmount();
});

for (const prompt of ["make a change", "please inspect", "?what changed", ",start here", ".check this"]) {
  test(`empty composer preserves ordinary prompt ${JSON.stringify(prompt)}`, async () => {
    const driver: CodingSessionDriver = { start: async () => undefined, cancel: async () => undefined };
    const application = new WorkflowApplication(new TaskGraph([]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
    const view = render(React.createElement(WorkflowTui, { application, session: new WorkflowCodingSession(driver) }));

    // Real terminals deliver ordinary typing one key at a time.
    view.stdin.write(prompt[0]!);
    view.stdin.write(prompt.slice(1));
    await waitForFrame(view, new RegExp(`❯ ${prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    assert.match(view.lastFrame() ?? "", new RegExp(`❯ ${prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    view.unmount();
  });
}

async function waitForFrame(view: { lastFrame(): string | undefined }, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!expected.test(view.lastFrame() ?? "") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("legacy Ink projection cancels a coding session without changing canonical task state", async () => {
  let cancelled = false;
  let release!: () => void;
  const driver: CodingSessionDriver = {
    async start(_prompt, emit) {
      emit({ type: "status", status: "working" });
      await new Promise<void>((resolve) => { release = resolve; });
    },
    async cancel() {
      cancelled = true;
      release();
    },
  };
  const task: WorkflowTask = { id: taskId("A"), title: "Keep state", state: "BLOCKED", dependencies: [], requiredEvidence: [] };
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application, session }));

  view.stdin.write("Do work");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\u0003");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cancelled, true);
  assert.match(view.lastFrame() ?? "", /cancelled/);
  assert.equal(application.snapshot().tasks[0]?.state, "READY");
  view.unmount();
});

test("the `/` menu cycles agent config on the active session", async () => {
  const selected: { id: string; value: string | boolean }[] = [];
  let configOptions = [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "m1",
    options: [{ value: "m1", name: "Model One" }, { value: "m2", name: "Model Two" }],
  }];
  const initialDriver: CodingSessionDriver = {
    start: async () => undefined,
    cancel: async () => undefined,
  };
  const task: WorkflowTask = { id: taskId("A"), title: "Model cycle", state: "BLOCKED", dependencies: [], requiredEvidence: [] };
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const view = render(React.createElement(WorkflowTui, {
    application,
    session: new WorkflowCodingSession(initialDriver),
    sessionConfigOptions: () => configOptions,
    onSetSessionConfig: async (id: string, value: string | boolean) => {
      selected.push({ id, value });
      configOptions = configOptions.map((option) => ({ ...option, currentValue: String(value) }));
    },
  }));

  const hintRegex = /1-5 toggles/;
  view.stdin.write("/");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(view.lastFrame() ?? "", hintRegex, "model item must tell the menu has five entries");
  assert.match(view.lastFrame() ?? "", /Model: Model One/);
  view.stdin.write("5"); // 5th menu item -> Model; the menu stays open
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(view.lastFrame() ?? "", /Workflow options/, "the menu must stay open while options cycle");
  assert.match(view.lastFrame() ?? "", /Model: Model Two/);
  assert.deepEqual(selected, [{ id: "model", value: "m2" }], "the active session must receive the advertised option value");
  view.unmount();
});
