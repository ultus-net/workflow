import { decodeWebpLossless } from "./webp-lossless.js";

/**
 * Petdex/Codex pet package support: a pet is a `pet.json` manifest plus a
 * `spritesheet.webp` lossless WebP laid out as 8 columns of 192x208 frames
 * (v1: 9 rows, v2: 11 rows). Row index selects the animation state.
 * https://petdex.dev / https://github.com/crafter-station/petdex
 */

export const CODEX_PET_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export type CodexPetState = (typeof CODEX_PET_STATES)[number];

export interface CodexPetFrame {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

export interface CodexPet {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly rows: number;
  readonly states: ReadonlyMap<string, readonly CodexPetFrame[]>;
}

const GRID_COLUMNS = 8;
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;

export function parseCodexPet(petJsonText: string, spritesheet: Uint8Array): CodexPet {
  let manifest: unknown;
  try {
    manifest = JSON.parse(petJsonText);
  } catch {
    throw new Error("pet.json is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null) throw new Error("pet.json must be an object");
  const record = manifest as Record<string, unknown>;
  const id = stringField(record, "id");
  const displayName = stringField(record, "displayName");

  const image = decodeWebpLossless(spritesheet);
  if (image.width % GRID_COLUMNS !== 0) {
    throw new Error(`pet spritesheet grid: width ${image.width} is not divisible into ${GRID_COLUMNS} columns`);
  }
  const frameWidth = image.width / GRID_COLUMNS;
  if (image.height % FRAME_HEIGHT !== 0) {
    throw new Error(`pet spritesheet grid: height ${image.height} is not a multiple of frame height ${FRAME_HEIGHT}`);
  }
  const rows = image.height / FRAME_HEIGHT;
  const frameHeight = image.height / rows;
  if (frameWidth !== FRAME_WIDTH || frameHeight !== FRAME_HEIGHT) {
    throw new Error(`pet spritesheet grid: frames are ${frameWidth}x${frameHeight}, expected 192x208`);
  }

  const states = new Map<string, CodexPetFrame[]>();
  for (let row = 0; row < rows; row++) {
    const state = CODEX_PET_STATES[row];
    if (state === undefined) continue; // v2 rows 9-10 have no assigned state yet
    const frames: CodexPetFrame[] = [];
    for (let column = 0; column < GRID_COLUMNS; column++) {
      frames.push(extractFrame(image, column, row, frameWidth, frameHeight));
    }
    states.set(state, frames);
  }
  return {
    id,
    displayName,
    description: typeof record.description === "string" ? record.description : "",
    frameWidth,
    frameHeight,
    rows,
    states,
  };
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`pet.json: field "${field}" must be a non-empty string`);
  return value;
}

function extractFrame(image: { width: number; rgba: Uint8ClampedArray }, column: number, row: number, frameWidth: number, frameHeight: number): CodexPetFrame {
  const rgba = new Uint8ClampedArray(frameWidth * frameHeight * 4);
  const originX = column * frameWidth;
  const originY = row * frameHeight;
  for (let y = 0; y < frameHeight; y++) {
    const source = ((originY + y) * image.width + originX) * 4;
    rgba.set(image.rgba.subarray(source, source + frameWidth * 4), y * frameWidth * 4);
  }
  return { width: frameWidth, height: frameHeight, rgba };
}
