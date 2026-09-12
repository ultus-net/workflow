import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { createGlyphcastMotionProject } from "../ui/glyphcast-motion.js";
import { renderMotionFrame } from "../ui/motion.js";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const path = process.argv[2];
const frameRate = process.argv[3] === undefined ? 12 : Number(process.argv[3]);
const width = process.argv[4] === undefined ? 29 : Number(process.argv[4]);
const height = process.argv[5] === undefined ? 5 : Number(process.argv[5]);
if (!path) {
  console.error("Usage: npm run motion:import -- <glyphcast.json> [frame-rate] [width] [height]");
  process.exit(1);
}

let data: unknown;
try {
  data = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  console.error(`Could not read Glyphcast export: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let project;
try {
  project = createGlyphcastMotionProject(data, frameRate, width, height);
} catch (error) {
  console.error(`Invalid Glyphcast export: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

for (let frame = 0; frame < project.durationFrames; frame++) {
  const clear = process.stdout.isTTY ? "\x1b[2J\x1b[H" : "";
  process.stdout.write(`${clear}${renderMotionFrame(project, frame)}\n`);
  if (frame + 1 < project.durationFrames) await delay(1000 / project.frameRate);
}
