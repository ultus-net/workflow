import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkflowCodingSession,
  type CodingSessionDriver,
  type CodingSessionEvent,
} from "../src/index.js";

class FakeSessionDriver implements CodingSessionDriver {
  readonly prompts: string[] = [];
  readonly images: (readonly { readonly mediaType: string; readonly data: string }[])[] = [];
  cancelled = false;

  constructor(readonly emitted: readonly CodingSessionEvent[]) {}

  async start(prompt: string, emit: (event: CodingSessionEvent) => void, images = []): Promise<void> {
    this.prompts.push(prompt);
    this.images.push(images);
    for (const event of this.emitted) emit(event);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

test("host-neutral coding session projects streaming activity and terminal completion", async () => {
  const driver = new FakeSessionDriver([
    { type: "assistant", text: "Inspecting repository" },
    { type: "tool-proposal", tool: "read_files", subjects: ["README.md"] },
    { type: "tool-outcome", tool: "read_files", outcome: "succeeded" },
    { type: "completed", result: "Repository inspected" },
  ]);
  const session = new WorkflowCodingSession(driver);
  const observed: CodingSessionEvent[] = [];

  session.subscribe((event) => observed.push(event));
  await session.submit("Inspect this repository");

  assert.deepEqual(driver.prompts, ["Inspect this repository"]);
  assert.deepEqual(observed, driver.emitted);
  assert.deepEqual(session.snapshot(), { state: "completed", result: "Repository inspected" });
});

test("host-neutral coding session forwards image attachments without provider-specific types", async () => {
  const driver = new FakeSessionDriver([{ type: "completed", result: "Image inspected" }]);
  const session = new WorkflowCodingSession(driver);
  const images = [{ mediaType: "image/png", data: "aW1hZ2U=" }];

  await session.submit("Inspect this image", images);

  assert.deepEqual(driver.prompts, ["Inspect this image"]);
  assert.deepEqual(driver.images, [images]);
});

test("host-neutral coding session preserves terminal failure", async () => {
  const driver = new FakeSessionDriver([{ type: "failed", reason: "provider unavailable" }]);
  const session = new WorkflowCodingSession(driver);

  await session.submit("Try the task");
  assert.deepEqual(session.snapshot(), { state: "failed", reason: "provider unavailable" });
  await session.cancel();
  assert.equal(driver.cancelled, false);
  assert.deepEqual(session.snapshot(), { state: "failed", reason: "provider unavailable" });
});

test("host-neutral coding session cancels an active driver and remains cancelled", async () => {
  let release!: () => void;
  const driver: CodingSessionDriver & { cancelled: boolean } = {
    cancelled: false,
    async start(_prompt, emit) {
      emit({ type: "assistant", text: "Working" });
      await new Promise<void>((resolve) => { release = resolve; });
      emit({ type: "completed", result: "late completion" });
    },
    async cancel() {
      this.cancelled = true;
    },
  };
  const session = new WorkflowCodingSession(driver);
  const running = session.submit("Try the task");

  await session.cancel();
  release();
  await running;

  assert.equal(driver.cancelled, true);
  assert.deepEqual(session.snapshot(), { state: "cancelled" });
});

test("host-neutral coding session converts an unhandled driver rejection to terminal failure", async () => {
  const session = new WorkflowCodingSession({
    async start() {
      throw new Error("driver disconnected");
    },
    async cancel() {},
  });

  await session.submit("Try the task");

  assert.deepEqual(session.snapshot(), { state: "failed", reason: "driver disconnected" });
});

test("host-neutral coding session exposes cancellation failure as terminal failure", async () => {
  let release!: () => void;
  const session = new WorkflowCodingSession({
    async start() { await new Promise<void>((resolve) => { release = resolve; }); },
    async cancel() { release(); throw new Error("stop failed"); },
  });
  void session.submit("work");
  await new Promise((resolve) => setTimeout(resolve, 0));

  await session.cancel();
  assert.deepEqual(session.snapshot(), { state: "failed", reason: "stop failed" });
});
