import assert from "node:assert/strict";
import test from "node:test";

import {
  createMotionSceneProject,
  createMotionProject,
  exportMotionFrames,
  frameAtElapsedTime,
  insertMotionFrames,
  interpolateKeyframes,
  removeMotionFrames,
  renderMotionFrame,
} from "../src/ui/motion.js";
import { WORKFLOW_RIBBON_PROJECT, WORKFLOW_SIGNAL_PROJECT, createWorkflowRibbonFrames } from "../src/ui/home-animation.js";
import { WORKFLOW_MOTION_EXAMPLES } from "../src/ui/motion-examples.js";
import { createGlyphcastMotionProject } from "../src/ui/glyphcast-motion.js";
import { fitGifToTerminal, gifToAnsiHalfBlockAnimation, gifToAsciiAnimation, rgbaToAnsiHalfBlocks, rgbaToAscii } from "../src/ui/gif-ascii.js";

test("motion projects render deterministic integer frames", () => {
  const seen: number[] = [];
  const project = createMotionProject({
    width: 3,
    height: 1,
    frameRate: 12,
    durationFrames: 4,
    renderFrame(frame) {
      seen.push(frame);
      return `${frame}  `;
    },
  });

  assert.equal(renderMotionFrame(project, 2), "2  ");
  assert.equal(renderMotionFrame(project, 2), "2  ");
  assert.deepEqual(seen, [2, 2]);
});

test("motion projects reject invalid dimensions, timing, frame indices, and output", () => {
  assert.throws(() => createMotionProject({ width: 0, height: 1, frameRate: 12, durationFrames: 4, renderFrame: () => "" }), RangeError);
  assert.throws(() => createMotionProject({ width: 3, height: 1, frameRate: 0, durationFrames: 4, renderFrame: () => "   " }), RangeError);
  assert.throws(() => createMotionProject({ width: 3, height: 1, frameRate: 12, durationFrames: 0, renderFrame: () => "   " }), RangeError);

  const project = createMotionProject({ width: 3, height: 1, frameRate: 12, durationFrames: 4, renderFrame: () => "   " });
  assert.throws(() => renderMotionFrame(project, -1), RangeError);
  assert.throws(() => renderMotionFrame(project, 4), RangeError);

  const malformed = createMotionProject({ width: 3, height: 1, frameRate: 12, durationFrames: 4, renderFrame: () => "xx" });
  assert.throws(() => renderMotionFrame(malformed, 0), RangeError);
});

test("motion keyframes interpolate numbers and hold discrete values", () => {
  assert.equal(interpolateKeyframes([{ frame: 0, value: 0 }, { frame: 10, value: 20 }], 5), 10);
  assert.equal(interpolateKeyframes([{ frame: 0, value: "a" }, { frame: 10, value: "b" }], 5), "a");
  assert.equal(interpolateKeyframes([{ frame: 2, value: 4 }, { frame: 6, value: 12 }], 0), 4);
  assert.equal(interpolateKeyframes([{ frame: 2, value: 4 }, { frame: 6, value: 12 }], 9), 12);
  assert.throws(() => interpolateKeyframes([{ frame: 0.5, value: 0 }], 0), RangeError);
  assert.throws(() => interpolateKeyframes([{ frame: 0, value: 0 }], Number.NaN), RangeError);
});

test("motion timeline edits shift keyframes without mutating the source", () => {
  const keys = [{ frame: 1, value: 10 }, { frame: 4, value: 40 }];
  assert.deepEqual(insertMotionFrames(keys, 3, 2), [{ frame: 1, value: 10 }, { frame: 6, value: 40 }]);
  assert.deepEqual(removeMotionFrames(keys, 2, 2), [{ frame: 1, value: 10 }, { frame: 2, value: 40 }]);
  assert.deepEqual(keys, [{ frame: 1, value: 10 }, { frame: 4, value: 40 }]);
});

test("motion playback derives looping frames from elapsed time without state", () => {
  assert.equal(frameAtElapsedTime(0, 10, 4), 0);
  assert.equal(frameAtElapsedTime(250, 10, 4), 2);
  assert.equal(frameAtElapsedTime(450, 10, 4), 0);
});

test("motion export samples canonical frames in order", () => {
  const project = createMotionProject({
    width: 1,
    height: 1,
    frameRate: 10,
    durationFrames: 3,
    renderFrame: (frame) => String(frame),
  });
  assert.deepEqual(exportMotionFrames(project), ["0", "1", "2"]);
});

test("motion scenes composite sparse cells and renderer layers in order", () => {
  const project = createMotionSceneProject({
    width: 5,
    height: 2,
    frameRate: 10,
    durationFrames: 2,
    layers: [
      { cells: [{ x: 0, y: 0, value: "A" }, { x: 4, y: 1, value: "Z" }] },
      { renderFrame: () => " B   \n     " },
      { cells: [{ x: 1, y: 0, value: "X" }] },
    ],
  });

  assert.equal(renderMotionFrame(project, 0), "AX   \n    Z");
});

test("motion scene translation keyframes move and clip authored cells", () => {
  const project = createMotionSceneProject({
    width: 4,
    height: 1,
    frameRate: 10,
    durationFrames: 3,
    layers: [{
      cells: [{ x: 0, y: 0, value: "@" }, { x: 1, y: 0, value: "." }],
      x: [{ frame: 0, value: -1 }, { frame: 2, value: 1 }],
    }],
  });

  assert.deepEqual(exportMotionFrames(project), [".   ", "@.  ", " @. "]);
});

test("motion scene translations round interpolated positions to terminal cells", () => {
  const project = createMotionSceneProject({
    width: 3,
    height: 1,
    frameRate: 10,
    durationFrames: 3,
    layers: [{ cells: [{ x: 0, y: 0, value: "x" }], x: [{ frame: 0, value: 0 }, { frame: 2, value: 1 }] }],
  });
  assert.deepEqual(exportMotionFrames(project), ["x  ", " x ", " x "]);
});

test("motion scenes reject non-finite translations", () => {
  const project = createMotionSceneProject({
    width: 2,
    height: 1,
    frameRate: 10,
    durationFrames: 1,
    layers: [{ cells: [{ x: 0, y: 0, value: "x" }], x: [{ frame: 0, value: Number.NaN }] }],
  });
  assert.throws(() => renderMotionFrame(project, 0), /finite numbers/);
});

test("motion scenes reject glyphs that are not one safe terminal cell", () => {
  const astral = createMotionSceneProject({
    width: 2, height: 1, frameRate: 10, durationFrames: 1,
    layers: [{ cells: [{ x: 0, y: 0, value: "😀" }] }],
  });
  assert.throws(() => renderMotionFrame(astral, 0), /safe terminal cell/);

  const rendered = createMotionSceneProject({
    width: 2, height: 1, frameRate: 10, durationFrames: 1,
    layers: [{ renderFrame: () => "界 " }],
  });
  assert.throws(() => renderMotionFrame(rendered, 0), /safe terminal cells/);
});

test("Workflow ribbon is a motion project with canonical terminal timing and export", () => {
  assert.equal(WORKFLOW_RIBBON_PROJECT.width, 29);
  assert.equal(WORKFLOW_RIBBON_PROJECT.height, 5);
  assert.equal(WORKFLOW_RIBBON_PROJECT.frameRate, 1000 / 140);
  assert.equal(WORKFLOW_RIBBON_PROJECT.durationFrames, 48);
  assert.deepEqual(exportMotionFrames(WORKFLOW_RIBBON_PROJECT), createWorkflowRibbonFrames());
});

test("Workflow motion system can author a sparse composition distinct from the ribbon", () => {
  const frames = exportMotionFrames(WORKFLOW_SIGNAL_PROJECT);
  assert.equal(WORKFLOW_SIGNAL_PROJECT.width, 29);
  assert.equal(WORKFLOW_SIGNAL_PROJECT.height, 5);
  assert.equal(frames.length, 12);
  assert.notEqual(frames[0], frames[6]);
  assert.match(frames[0]!, /[+|]/);
  assert.ok(frames.every((frame) => !frame.includes("⣿")));
});

test("Workflow motion examples provide distinct animated 29x5 studies", () => {
  assert.deepEqual(WORKFLOW_MOTION_EXAMPLES.map((example) => example.name), [
    "particles", "type", "contours", "interference", "aperture", "rain",
  ]);

  const signatures = new Set<string>();
  for (const example of WORKFLOW_MOTION_EXAMPLES) {
    const frames = exportMotionFrames(example.project);
    assert.equal(example.project.width, 29);
    assert.equal(example.project.height, 5);
    assert.ok(frames.length >= 12 && frames.length <= 60);
    assert.ok(new Set(frames).size >= 4, `${example.name} should visibly animate`);
    assert.ok(frames.every((frame) => frame.split("\n").length === 5));
    signatures.add(frames.slice(0, 4).join("\n---\n"));
  }
  assert.equal(signatures.size, WORKFLOW_MOTION_EXAMPLES.length);
});

test("Glyphcast v1 exports fit their complete ASCII raster into a 29x5 motion project", () => {
  const rows = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 58 }, (_, x) => x === 0 && y === 0 ? "@" : x >= 56 && y >= 8 ? "O" : " ").join(""),
  );
  const project = createGlyphcastMotionProject({ version: 1, frameCount: 2, frames: [rows.join("\n"), rows.join("\n")] }, 12);

  assert.equal(project.width, 29);
  assert.equal(project.height, 5);
  assert.equal(project.frameRate, 12);
  assert.equal(project.durationFrames, 2);
  const output = renderMotionFrame(project, 0);
  assert.equal(output.split("\n").length, 5);
  assert.equal(output[0], "@");
  assert.equal(output.split("\n")[4]![28], "O");
});

test("Glyphcast imports reject malformed exports and unsafe terminal glyphs", () => {
  assert.throws(() => createGlyphcastMotionProject({ version: 2, frameCount: 1, frames: ["x"] }, 12), /Glyphcast v1/);
  assert.throws(() => createGlyphcastMotionProject({ version: 1, frameCount: 2, frames: ["x"] }, 12), /frameCount/);
  assert.throws(() => createGlyphcastMotionProject({ version: 1, frameCount: 1, frames: ["界"] }, 12), /safe ASCII/);
  assert.throws(() => createGlyphcastMotionProject({ version: 1, frameCount: 1, frames: ["x".repeat(10_001)] }, 12), /dimensions/);
  assert.throws(() => createGlyphcastMotionProject({ version: 1, frameCount: 1, frames: ["x"] }, 0.01), /frame rate/);
});

test("Glyphcast exports can retain more detail in a larger viewport", () => {
  const frame = Array.from({ length: 40 }, (_, y) =>
    Array.from({ length: 100 }, (_, x) => x === y ? "@" : ".").join(""),
  ).join("\n");
  const project = createGlyphcastMotionProject({ version: 1, frameCount: 1, frames: [frame] }, 12, 100, 40);

  assert.equal(project.width, 100);
  assert.equal(project.height, 40);
  assert.equal(renderMotionFrame(project, 0), frame);
});

test("GIF ASCII rendering area-averages source pixels before mapping luminance", () => {
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
  ]);

  assert.equal(rgbaToAscii(rgba, 2, 2, 1, 1, " .#"), ".");
});

test("GIF ASCII rendering preserves spatial detail at the requested terminal size", () => {
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255,
  ]);

  assert.equal(rgbaToAscii(rgba, 2, 2, 2, 2, " @"), " @\n@ ");
});

test("GIF half-block rendering preserves truecolor and transparent pixels", () => {
  const rgba = new Uint8ClampedArray([
    12, 34, 56, 255, 0, 0, 0, 0,
    78, 90, 123, 255, 210, 45, 67, 255,
  ]);

  assert.equal(
    rgbaToAnsiHalfBlocks(rgba, 2, 2, 2, 1),
    "\x1b[38;2;12;34;56m\x1b[48;2;78;90;123m▀\x1b[0m\x1b[38;2;210;45;67m▄\x1b[0m",
  );
});

test("GIF half-block rendering preserves sparse pixel-art edges", () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  rgba.set([18, 20, 24, 255], 0);

  assert.match(rgbaToAnsiHalfBlocks(rgba, 4, 4, 1, 1), /18;20;24/);
});

test("GIF terminal sizing contains source pixels with terminal-cell aspect correction", () => {
  assert.deepEqual(fitGifToTerminal(300, 280, 200, 70), { width: 150, height: 70 });
  assert.deepEqual(fitGifToTerminal(300, 280, 100, 20), { width: 43, height: 20 });
});

test("GIF decoding produces terminal-sized frames with source timing", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAABAAAALAAAAAABAAEAAAIBTAA7", "base64");
  const animation = gifToAsciiAnimation(gif, 10, 10);

  assert.equal(animation.frames.length, 1);
  assert.equal(animation.frames[0]!.split("\n").length, 5);
  assert.equal(animation.frames[0]!.split("\n").every((line) => line.length === 10), true);
  assert.deepEqual({ width: animation.width, height: animation.height }, { width: 10, height: 5 });
  assert.deepEqual(animation.delays, [10]);
});

test("GIF decoding can produce truecolor half-block animation frames", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAABAAAALAAAAAABAAEAAAIBTAA7", "base64");
  const animation = gifToAnsiHalfBlockAnimation(gif, 10, 5);

  assert.deepEqual({ width: animation.width, height: animation.height }, { width: 10, height: 5 });
  assert.equal(animation.frames[0]!.split("\n").length, 5);
  assert.ok(animation.frames[0]!.includes("\x1b[38;2;"));
  assert.deepEqual(animation.delays, [10]);
});

test("GIF half-block animation crops transparent margins before terminal fitting", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAABAAAALAAAAAABAAEAAAIBTAA7", "base64");
  const animation = gifToAnsiHalfBlockAnimation(gif, 10, 5);

  assert.deepEqual({ width: animation.width, height: animation.height }, { width: 10, height: 5 });
});
