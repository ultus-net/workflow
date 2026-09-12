import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCodexPet } from "../src/ui/pets/codex-pet.js";
import { renderCodexPetFrame, codexPetStateFrames, petStateForActivity } from "../src/ui/pets/codex-pet-renderer.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const PET_JSON = JSON.stringify({ id: "cat", displayName: "Cat", spritesheetPath: "spritesheet.webp" });

function pet() {
  return parseCodexPet(PET_JSON, fixture("grid8x2.webp"));
}

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
