import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCodexPet } from "../src/ui/pets/codex-pet.js";
import { renderCodexPetFrame, codexPetStateFrames, petStateForActivity, cropCodexPetFrame } from "../src/ui/pets/codex-pet-renderer.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

test("cropCodexPetFrame trims transparent margins", () => {
  // 8x8 frame: content occupies columns 1..6, rows 2..7 only
  const rgba = new Uint8ClampedArray(8 * 8 * 4);
  const paint = (x: number, y: number) => {
    const off = (y * 8 + x) * 4;
    rgba[off] = 200; rgba[off + 1] = 200; rgba[off + 2] = 200; rgba[off + 3] = 255;
  };
  for (let y = 2; y <= 7; y++) for (let x = 1; x <= 6; x++) paint(x, y);
  const cropped = cropCodexPetFrame({ width: 8, height: 8, rgba });
  assert.equal(cropped.width, 6);
  assert.equal(cropped.height, 6);
  assert.equal(cropped.rgba.length, 6 * 6 * 4);
  // cropping is idempotent
  const again = cropCodexPetFrame(cropped);
  assert.equal(again.width, 6);
  assert.equal(again.height, 6);
});

test("cropCodexPetFrame keeps a fully transparent frame untouched", () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  const cropped = cropCodexPetFrame({ width: 4, height: 4, rgba });
  assert.equal(cropped.width, 4);
  assert.equal(cropped.height, 4);
});

const PET_JSON = JSON.stringify({ id: "cat", displayName: "Cat", spritesheetPath: "spritesheet.webp" });

function pet() {
  return parseCodexPet(PET_JSON, fixture("grid8x2.webp"));
}

test("codexPetStateFrames renders all frames with identical dimensions", () => {
  const frames = codexPetStateFrames(pet(), "idle", 12);
  const dims = frames.map((frame) => frame.split("\n").length);
  assert.equal(new Set(dims).size, 1);
});

test("renderCodexPetFrame produces ANSI half-block art at requested width", () => {
  const frame = pet().states.get("idle")![0]!;
  const art = renderCodexPetFrame(frame, 24);
  const lines = art.split("\n");
  // 192x208 at 24 cells wide: height = 24 * 208/192 / 2 = 13 rows
  assert.equal(lines.length, 13);
  // fixture idle row frame 0 is solid-ish: first cell should carry fg color (0,0,0)
  const ESC = "\x1b";
  assert.ok(lines[0]!.includes(`${ESC}[38;2;0;0;0m`));
  // second state's first frame is (60,0,0): no such color in idle frame 0
  assert.ok(!lines[0]!.includes(`${ESC}[38;2;60;0;0m`));
});

test("codexPetStateFrames renders all frames of a state", () => {
  const frames = codexPetStateFrames(pet(), "idle", 12);
  assert.equal(frames.length, 8);
  assert.equal(new Set(frames).size, 8); // each column differs in fixture
});

test("petStateForActivity maps workflow signals onto pet states", () => {
  assert.equal(petStateForActivity("running"), "running");
  assert.equal(petStateForActivity("failed"), "failed");
  assert.equal(petStateForActivity("unknown-signal"), "idle");
});

test("renderCodexPetFrame rejects unknown state", () => {
  assert.throws(() => codexPetStateFrames(pet(), "waving", 12), /waving/);
});
