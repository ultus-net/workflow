import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  WorkflowTui,
  hostCapabilities,
  type CodingSessionDriver,
  type DecisionBrief,
  type LearningOpportunity,
} from "../src/index.js";

function createApplication(): WorkflowApplication {
  return new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
}

async function waitForFrame(view: { lastFrame(): string | undefined }, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!expected.test(view.lastFrame() ?? "") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("TUI menu cycles speech and build styles in the mode bar", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("2");
  await waitForFrame(view, /🪨/);
  assert.match(view.lastFrame() ?? "", /🪨/);

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("3");
  await waitForFrame(view, /pt·lite/);
  assert.match(view.lastFrame() ?? "", /pt·lite/);

  view.unmount();
});

test("TUI style changes propagate to onStyleChange for live session restyling", async () => {
  const styles: unknown[] = [];
  const view = render(React.createElement(WorkflowTui, {
    application: createApplication(),
    onStyleChange: (style) => styles.push(style),
  }));

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("2");
  await waitForFrame(view, /caveman/);
  assert.deepEqual(styles.at(-1), { speech: "caveman", build: "normal" });
  view.unmount();
});


test("TUI installs the pedagogy gate via onModeChange on mount and menu changes", async () => {
  const modes: string[] = [];
  const view = render(React.createElement(WorkflowTui, {
    application: createApplication(),
    onModeChange: (mode: string) => modes.push(mode),
  }));

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Learn to Code/);
  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Socratic Tutor/);

  assert.deepEqual(modes, ["autonomous", "learn-to-code", "socratic-tutor"]);
  view.unmount();
});


test("TUI / opens the Workflow options menu and 1-6 toggle options", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  // Empty composer shows the labeled keys hint.
  assert.match(view.lastFrame() ?? "", /keys: \/ menu/);

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  const menu = view.lastFrame() ?? "";
  assert.match(menu, /Mode: Autonomous/);
  assert.match(menu, /Speech: normal/);
  assert.match(menu, /Build: normal/);
  assert.match(menu, /Learner profile/);
  assert.match(menu, /Inspect symbol/);
  assert.match(menu, /Workflow details/);

  // Digit 1 cycles the mode and closes the menu.
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Learn to Code/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Workflow options/);
  view.unmount();
});

test("TUI Ctrl+P opens the Workflow options menu without consuming composer text", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  view.stdin.write("\u0010");
  await waitForFrame(view, /Workflow options/);
  assert.match(view.lastFrame() ?? "", /Mode: Autonomous/);
  view.unmount();
});

test("TUI / menu digit selection runs the option and q closes", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);

  // Digit 2 is Speech.
  view.stdin.write("2");
  await waitForFrame(view, /Speech: caveman|🪨/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Workflow options/);

  // Reopen, then q closes without changing anything.
  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("q");
  await waitForFrame(view, /keys: \/ menu/);
  assert.match(view.lastFrame() ?? "", /keys: \/ menu/);
  view.unmount();
});

test("TUI shows the autonomous mode by default and the menu cycles pedagogical modes", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  assert.match(view.lastFrame() ?? "", /\[Mode: Autonomous\]/);

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Learn to Code\]/);
  assert.match(view.lastFrame() ?? "", /\[Mode: Learn to Code\]/);

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Socratic Tutor\]/);
  assert.match(view.lastFrame() ?? "", /\[Mode: Socratic Tutor\]/);

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Co-Architect/);
  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Walkthrough/);
  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("1");
  await waitForFrame(view, /\[Mode: Autonomous/);
  assert.match(view.lastFrame() ?? "", /\[Mode: Autonomous\]/);
  view.unmount();
});

test("TUI menu toggles a learner profile panel rendering concept stages", async () => {
  const view = render(
    React.createElement(WorkflowTui, {
      application: createApplication(),
      profile: {
        version: 1,
        concepts: {
          closures: { stage: "developing", lastObservedAt: 1, evidence: [] },
          "async-await": { stage: "independent", lastObservedAt: 2, evidence: [] },
        },
      },
    }),
  );

  assert.doesNotMatch(view.lastFrame() ?? "", /Learner Profile/);
  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("4");
  await waitForFrame(view, /Learner Profile/);
  assert.match(view.lastFrame() ?? "", /Learner Profile/);
  assert.match(view.lastFrame() ?? "", /closures\s+developing/);
  assert.match(view.lastFrame() ?? "", /async-await\s+independent/);

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("4");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotMatch(view.lastFrame() ?? "", /Learner Profile/);
  view.unmount();
});

test("TUI menu shows a symbol inspect hint panel that invokes onInspectSymbol", async () => {
  const inspected: string[] = [];
  const view = render(
    React.createElement(WorkflowTui, {
      application: createApplication(),
      onInspectSymbol: (symbol) => inspected.push(symbol),
    }),
  );

  view.stdin.write("/");
  await waitForFrame(view, /Workflow options/);
  view.stdin.write("5");
  await waitForFrame(view, /Symbol Inspect/);
  assert.match(view.lastFrame() ?? "", /Symbol Inspect/);
  view.stdin.write("reduce");
  await waitForFrame(view, /reduce/);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(inspected, ["reduce"]);
  view.unmount();
});

const BRIEF: DecisionBrief = {
  title: "Use atomic writes",
  context: "Profile persistence must not corrupt on crash.",
  chosenOption: { name: "write-then-rename", rationale: "Atomic on POSIX", blastRadius: "low" },
  rejectedAlternatives: [{ name: "in-place write", drawback: "can corrupt on crash" }],
  tradeoffs: { benefits: ["crash-safe"], liabilities: ["temp files"] },
};

const OPPORTUNITY: LearningOpportunity = {
  concept: "closures",
  type: "new-concept",
  relevance: 0.9,
  consequence: 0.4,
  teachableInsight: "Closures capture surrounding scope.",
  socraticQuestion: "What happens to the captured variable after the outer function returns?",
};

test("TUI renders decision-brief and tutor-checkpoint events as drawers above the transcript", async () => {
  const driver: CodingSessionDriver = {
    async start(_prompt, emit) {
      emit({ type: "decision-brief", brief: BRIEF });
      emit({ type: "tutor-checkpoint", opportunity: OPPORTUNITY });
      emit({ type: "assistant", text: "done" });
      emit({ type: "completed", result: "finished" });
    },
    async cancel() {},
  };
  const session = new WorkflowCodingSession(driver);
  const view = render(React.createElement(WorkflowTui, { application: createApplication(), session }));

  view.stdin.write("go");
  view.stdin.write("\r");
  await waitForFrame(view, /Decision Brief/);

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Decision Brief/);
  assert.match(frame, /Use atomic writes/);
  assert.match(frame, /write-then-rename/);
  assert.match(frame, /Socratic Question/);
  // The question wraps at the drawer width, so match a wrap-proof substring.
  assert.match(frame, /captured variable/);
  // Drawers render above the transcript.
  assert.ok(frame.indexOf("Decision Brief") < frame.indexOf("done"));
  view.unmount();
});
