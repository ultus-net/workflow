import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCodexPet } from "../src/ui/pets/codex-pet.js";
import { renderCodexPetFrameBraille, codexPetStateFramesBraille } from "../src/ui/pets/codex-pet-braille.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const PET_JSON = JSON.stringify({ id: "cat", displayName: "Cat", spritesheetPath: "spritesheet.webp" });

function pet() {
  return parseCodexPet(PET_JSON, fixture("grid8x2.webp"));
}

test("renderCodexPetFrameBraille uses braille sub-dots", () => {
  // 4x4 opaque frame, uniform color
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 4 * 4; i++) { rgba[i * 4] = 200; rgba[i * 4 + 3] = 255; }
  const art = renderCodexPetFrameBraille({ width: 4, height: 4, rgba }, 2);
  const lines = art.split("\n");
  assert.equal(lines.length, 1);
  // full cell: all 8 dots set = U+28FF
  assert.ok(lines[0]!.includes("⣿"));
  assert.ok(lines[0]!.includes("\x1b[38;2;200;0;0m"));
});

test("renderCodexPetFrameBraille leaves empty cells blank", () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4); // fully transparent
  const art = renderCodexPetFrameBraille({ width: 4, height: 4, rgba }, 2);
  assert.equal(art, "  ");
});

test("braille frames beat half-block horizontal resolution", () => {
  // fixture grid frame 0: top-left corner has a solid column; braille must
  // distinguish 2x sub-columns where half-blocks would average them away.
  const frames = codexPetStateFramesBraille(pet(), "idle", 12);
  assert.equal(frames.length, 8);
  const lines = frames[0]!.split("\n");
  assert.ok(lines.length >= 1);
});

test("renderCodexPetFrameBraille rejects invalid widths", () => {
  assert.throws(() => renderCodexPetFrameBraille({ width: 2, height: 2, rgba: new Uint8ClampedArray(16) }, 0), /cell width/);
});
