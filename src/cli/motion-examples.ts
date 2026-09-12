import { setTimeout as delay } from "node:timers/promises";

import { frameAtElapsedTime, renderMotionFrame } from "../ui/motion.js";
import { WORKFLOW_MOTION_EXAMPLES } from "../ui/motion-examples.js";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const name = process.argv[2];
if (!name || name === "--list") {
  for (const example of WORKFLOW_MOTION_EXAMPLES) console.log(`${example.name.padEnd(13)} ${example.description}`);
  process.exit(name ? 0 : 1);
}

const example = WORKFLOW_MOTION_EXAMPLES.find((candidate) => candidate.name === name);
if (!example) {
  console.error(`Unknown motion example: ${name}. Use --list to see available examples.`);
  process.exit(1);
}

const requestedFrames = process.argv[3] === undefined ? example.project.durationFrames : Number(process.argv[3]);
if (!Number.isInteger(requestedFrames) || requestedFrames <= 0 || requestedFrames > 240) {
  console.error("Frame count must be an integer from 1 to 240.");
  process.exit(1);
}

const startedAt = Date.now();
for (let index = 0; index < requestedFrames; index++) {
  const frame = frameAtElapsedTime(Date.now() - startedAt, example.project.frameRate, example.project.durationFrames);
  const clear = process.stdout.isTTY ? "\x1b[2J\x1b[H" : "";
  process.stdout.write(`${clear}${example.name}  ${example.description}\n\n${renderMotionFrame(example.project, frame)}\n`);
  if (index + 1 < requestedFrames) await delay(1000 / example.project.frameRate);
}
