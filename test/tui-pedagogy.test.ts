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

test("TUI , and . cycle speech and build styles in the mode bar", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  view.stdin.write(",");
  await waitForFrame(view, /🪨/);
  assert.match(view.lastFrame() ?? "", /🪨/);

  view.stdin.write(".");
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

  view.stdin.write(",");
  await waitForFrame(view, /caveman/);
  assert.deepEqual(styles.at(-1), { speech: "caveman", build: "normal" });
  view.unmount();
});


test("TUI shows the autonomous mode by default and m cycles pedagogical modes", async () => {
  const view = render(React.createElement(WorkflowTui, { application: createApplication() }));

  assert.match(view.lastFrame() ?? "", /\[Mode: Autonomous \(m to switch\)\]/);

  view.stdin.write("m");
  await waitForFrame(view, /\[Mode: Learn to Code \(m to switch\)\]/);
  assert.match(view.lastFrame() ?? "", /\[Mode: Learn to Code \(m to switch\)\]/);

  view.stdin.write("m");
  await waitForFrame(view, /\[Mode: Socratic Tutor \(m to switch\)\]/);
  assert.match(view.lastFrame() ?? "", /\[Mode: Socratic Tutor \(m to switch\)\]/);

  view.stdin.write("m");
  await waitForFrame(view, /\[Mode: Co-Architect/);
  view.stdin.write("m");
  await waitForFrame(view, /\[Mode: Walkthrough/);
  view.stdin.write("m");
  await waitForFrame(view, /\[Mode: Autonomous/);
  assert.match(view.lastFrame() ?? "", /\[Mode: Autonomous \(m to switch\)\]/);
  view.unmount();
});

test("TUI p toggles a learner profile panel rendering concept stages", async () => {
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
  view.stdin.write("p");
  await waitForFrame(view, /Learner Profile/);
  assert.match(view.lastFrame() ?? "", /Learner Profile/);
  assert.match(view.lastFrame() ?? "", /closures\s+developing/);
  assert.match(view.lastFrame() ?? "", /async-await\s+independent/);

  view.stdin.write("p");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotMatch(view.lastFrame() ?? "", /Learner Profile/);
  view.unmount();
});

test("TUI ? shows a symbol inspect hint panel that invokes onInspectSymbol", async () => {
  const inspected: string[] = [];
  const view = render(
    React.createElement(WorkflowTui, {
      application: createApplication(),
      onInspectSymbol: (symbol) => inspected.push(symbol),
    }),
  );

  view.stdin.write("?");
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
