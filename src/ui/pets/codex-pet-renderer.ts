import { rgbaToAnsiHalfBlocks } from "../gif-ascii.js";
import type { CodexPet, CodexPetFrame } from "./codex-pet.js";

/** Terminal cell aspect: each character cell holds two vertical pixels. */
const CELL_ASPECT = 2;

/** Alpha below this counts as transparent margin when cropping. */
const CROP_ALPHA_THRESHOLD = 16;

/** Trims fully-transparent rows/columns from a frame; keeps at least 1x1. */
export function cropCodexPetFrame(frame: CodexPetFrame): CodexPetFrame {
  let left = 0;
  let right = frame.width - 1;
  let top = 0;
  let bottom = frame.height - 1;
  const isEmpty = (x: number, y: number) => frame.rgba[(y * frame.width + x) * 4 + 3]! < CROP_ALPHA_THRESHOLD;
  while (left < right && Array.from({ length: frame.height }, (_, y) => isEmpty(left, y)).every(Boolean)) left++;
  while (right > left && Array.from({ length: frame.height }, (_, y) => isEmpty(right, y)).every(Boolean)) right--;
  while (top < bottom && Array.from({ length: right - left + 1 }, (_, i) => isEmpty(left + i, top)).every(Boolean)) top++;
  while (bottom > top && Array.from({ length: right - left + 1 }, (_, i) => isEmpty(left + i, bottom)).every(Boolean)) bottom--;
  if (left === right || top === bottom) return frame;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    rgba.set(frame.rgba.subarray(((top + y) * frame.width + left) * 4, ((top + y) * frame.width + left + width) * 4), y * width * 4);
  }
  return { width, height, rgba };
}

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
  const cropped = cropCodexPetFrames(frames);
  return cropped.map((frame) => renderCodexPetFrame(frame, cellWidth));
}

/** Crops all frames to the union of their content bounds so animations stay aligned. */
export function cropCodexPetFrames(frames: readonly CodexPetFrame[]): CodexPetFrame[] {
  if (frames.length === 0) return [];
  const first = frames[0]!;
  const width = first.width;
  const height = first.height;
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (const frame of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (frame.rgba[(y * width + x) * 4 + 3]! >= CROP_ALPHA_THRESHOLD) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
  }
  if (left > right || top > bottom) return frames.map((frame) => ({ width: frame.width, height: frame.height, rgba: frame.rgba }));
  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  return frames.map((frame) => {
    const rgba = new Uint8ClampedArray(cropWidth * cropHeight * 4);
    for (let y = 0; y < cropHeight; y++) {
      rgba.set(frame.rgba.subarray(((top + y) * width + left) * 4, ((top + y) * width + left + cropWidth) * 4), y * cropWidth * 4);
    }
    return { width: cropWidth, height: cropHeight, rgba };
  });
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
