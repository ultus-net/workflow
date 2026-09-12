import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCodexPet, CODEX_PET_STATES } from "../src/ui/pets/codex-pet.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const PET_JSON = JSON.stringify({ id: "cat", displayName: "Cat", description: "test cat", spritesheetPath: "spritesheet.webp" });

test("parseCodexPet slices an 8x2 grid into state rows", () => {
  const pet = parseCodexPet(PET_JSON, fixture("grid8x2.webp"));
  assert.equal(pet.id, "cat");
  assert.equal(pet.displayName, "Cat");
  assert.equal(pet.frameWidth, 192);
  assert.equal(pet.frameHeight, 208);
  // two rows: idle and running-right, 8 frames each
  assert.equal(pet.states.get("idle")?.length, 8);
  assert.equal(pet.states.get("running-right")?.length, 8);
  assert.equal(pet.states.get("waving"), undefined);
  // fixture generator colors frame (fx, fy) as (fy*60, fx*30, x//20*10, 255)
  const idle = pet.states.get("idle")!;
  const frame1 = idle[1]!;
  const off = (0 * 192 + 5) * 4; // row 0, pixel x=5
  assert.deepEqual(
    [frame1.rgba[off], frame1.rgba[off + 1], frame1.rgba[off + 2], frame1.rgba[off + 3]],
    [0, 30, 0, 255],
  );
  const runningRight = pet.states.get("running-right")!;
  const frame0 = runningRight[0]!;
  assert.deepEqual(
    [frame0.rgba[0], frame0.rgba[1], frame0.rgba[2], frame0.rgba[3]],
    [60, 0, 0, 255],
  );
});

test("parseCodexPet rejects malformed pet.json", () => {
  assert.throws(() => parseCodexPet("not json", fixture("grid8x2.webp")), /pet\.json/);
  assert.throws(() => parseCodexPet(JSON.stringify({ id: 5 }), fixture("grid8x2.webp")), /id/);
  assert.throws(() => parseCodexPet(JSON.stringify({ id: "x" }), fixture("grid8x2.webp")), /displayName/);
});

test("parseCodexPet rejects nonstandard grid dimensions", () => {
  // tiny4x4 is 4x4: not a multiple of 8 columns
  assert.throws(() => parseCodexPet(PET_JSON, fixture("tiny4x4.webp")), /grid/);
});

test("CODEX_PET_STATES lists the nine v1 rows", () => {
  assert.deepEqual(CODEX_PET_STATES.slice(0, 9), [
    "idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review",
  ]);
});
