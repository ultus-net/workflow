import { rgbaToAnsiHalfBlocks } from "../gif-ascii.js";
import type { CodexPet, CodexPetFrame } from "./codex-pet.js";

/** Terminal cell aspect: each character cell holds two vertical pixels. */
const CELL_ASPECT = 2;

export function renderCodexPetFrame(frame: CodexPetFrame, cellWidth: number): string {
  if (!Number.isInteger(cellWidth) || cellWidth <= 0 || cellWidth > 120) {
    throw new RangeError("cell width must be an integer from 1 to 120");
  }
  const cellHeight = Math.max(1, Math.round((cellWidth * frame.height) / (frame.width * CELL_ASPECT)));
  return rgbaToAnsiHalfBlocks(frame.rgba, frame.width, frame.height, cellWidth, cellHeight);
}

export function codexPetStateFrames(pet: CodexPet, state: string, cellWidth: number): string[] {
  const frames = pet.states.get(state);
  if (frames === undefined) throw new Error(`pet "${pet.id}" has no "${state}" state`);
  return frames.map((frame) => renderCodexPetFrame(frame, cellWidth));
}

/** Maps a Workflow activity signal onto the closest pet state row. */
export function petStateForActivity(activity: string): string {
  switch (activity) {
    case "running":
    case "in-progress":
      return "running";
    case "failed":
    case "denied":
      return "failed";
    case "waiting":
    case "blocked":
    case "verifying":
      return "waiting";
    default:
      return "idle";
  }
}
