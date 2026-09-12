#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseCodexPet } from "../ui/pets/codex-pet.js";
import { codexPetStateFramesBraille } from "../ui/pets/codex-pet-braille.js";
import { petStateForActivity } from "../ui/pets/codex-pet-renderer.js";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const path = process.argv[2];
const state = petStateForActivity(process.argv[3] ?? "idle");
const width = process.argv[4] === undefined ? 24 : Number(process.argv[4]);
const frames = process.argv[5] === undefined ? 24 : Number(process.argv[5]);
if (path === undefined) {
  console.error("Usage: npm run pets -- <pet-dir> [state] [cell-width] [frame-count]\nPlays a Petdex/Codex pet package (pet.json + spritesheet.webp) in the terminal.");
  process.exit(1);
}

const petJson = await readFile(join(path, "pet.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
  console.error(`Could not read pet.json in ${path}: ${error.message}`);
  process.exit(1);
});
const spritesheet = new Uint8Array(await readFile(join(path, "spritesheet.webp")).catch(() => readFile(join(path, "sprite.webp"))).catch((error: NodeJS.ErrnoException) => {
  console.error(`Could not read spritesheet in ${path}: ${error.message}`);
  process.exit(1);
}));

const pet = parseCodexPet(petJson, spritesheet);
let art;
try {
  art = codexPetStateFramesBraille(pet, state, width);
} catch {
  console.error(`Pet has no "${state}" state; available: ${[...pet.states.keys()].join(", ")}`);
  process.exit(1);
}

console.log(`${pet.displayName} (${pet.id}), state: ${state}, ${pet.frameWidth}x${pet.frameHeight}`);
for (let frame = 0; frame < frames; frame++) {
  const clear = process.stdout.isTTY ? "\x1b[2J\x1b[H" : "";
  process.stdout.write(`${clear}${art[frame % art.length]}\n`);
  await delay(100);
}
