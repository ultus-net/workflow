import type { CodexPet, CodexPetFrame } from "./codex-pet.js";
import { cropCodexPetFrames } from "./codex-pet-renderer.js";

/**
 * Braille rendering: each terminal cell carries 2x4 sub-dots, roughly quadrupling
 * effective resolution versus half-blocks at the same character size.
 */

const DOTS: ReadonlyArray<readonly [number, number, number]> = [
  // [dx, dy, bit]
  [0, 0, 0], [0, 1, 1], [0, 2, 2], [1, 0, 3],
  [1, 1, 4], [1, 2, 5], [0, 3, 6], [1, 3, 7],
];

const DOT_ALPHA_THRESHOLD = 0.5;
const BRAILLE_BASE = 0x2800;

export function renderCodexPetFrameBraille(frame: CodexPetFrame, cellWidth: number): string {
  if (!Number.isInteger(cellWidth) || cellWidth <= 0 || cellWidth > 120) {
    throw new RangeError("cell width must be an integer from 1 to 120");
  }
  // Braille dots are roughly square; two dots per cell width, four per height.
  const dotWidth = cellWidth * 2;
  const dotHeight = Math.max(4, Math.ceil(Math.round((dotWidth * frame.height) / frame.width / 2) / 4) * 4);
  const cellHeight = dotHeight / 4;

  const rows: string[] = [];
  for (let cy = 0; cy < cellHeight; cy++) {
    let row = "";
    for (let cx = 0; cx < cellWidth; cx++) {
      let bits = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      let weight = 0;
      for (const [dx, dy, bit] of DOTS) {
        const [r, g, b, alpha] = sampleDot(frame, cx * 2 + dx, cy * 4 + dy, dotWidth, dotHeight);
        if (alpha < DOT_ALPHA_THRESHOLD) continue;
        bits |= 1 << bit;
        red += r * alpha;
        green += g * alpha;
        blue += b * alpha;
        weight += alpha;
      }
      if (bits === 0) {
        row += " ";
        continue;
      }
      const color = `${Math.round(red / weight)};${Math.round(green / weight)};${Math.round(blue / weight)}`;
      // Solid interior cells render as a full block; braille dots only mark edges.
      row += bits === 0xff
        ? `\x1b[38;2;${color}m█\x1b[0m`
        : `\x1b[38;2;${color}m${String.fromCharCode(BRAILLE_BASE | bits)}\x1b[0m`;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

export function codexPetStateFramesBraille(pet: CodexPet, state: string, cellWidth: number): string[] {
  const frames = pet.states.get(state);
  if (frames === undefined) throw new Error(`pet "${pet.id}" has no "${state}" state`);
  return cropCodexPetFrames(frames).map((frame) => renderCodexPetFrameBraille(frame, cellWidth));
}

function sampleDot(frame: CodexPetFrame, dx: number, dy: number, dotWidth: number, dotHeight: number): [number, number, number, number] {
  const x0 = dx * frame.width / dotWidth;
  const x1 = (dx + 1) * frame.width / dotWidth;
  const y0 = dy * frame.height / dotHeight;
  const y1 = (dy + 1) * frame.height / dotHeight;
  let red = 0;
  let green = 0;
  let blue = 0;
  let alphaArea = 0;
  let area = 0;
  for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < frame.height; sy++) {
    const yWeight = Math.min(y1, sy + 1) - Math.max(y0, sy);
    for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < frame.width; sx++) {
      const weight = yWeight * (Math.min(x1, sx + 1) - Math.max(x0, sx));
      const offset = (sy * frame.width + sx) * 4;
      const a = frame.rgba[offset + 3]! / 255;
      red += frame.rgba[offset]! * a * weight;
      green += frame.rgba[offset + 1]! * a * weight;
      blue += frame.rgba[offset + 2]! * a * weight;
      alphaArea += a * weight;
      area += weight;
    }
  }
  if (area === 0) return [0, 0, 0, 0];
  const coverage = alphaArea / area;
  if (alphaArea === 0) return [0, 0, 0, 0];
  return [red / alphaArea, green / alphaArea, blue / alphaArea, coverage];
}
