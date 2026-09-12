import { createMotionProject, type MotionProject } from "./motion.js";

interface GlyphcastExportV1 {
  readonly version: 1;
  readonly frameCount: number;
  readonly frames: readonly string[];
}

export function createGlyphcastMotionProject(value: unknown, frameRate = 12, width = 29, height = 5): MotionProject {
	const frames = parseGlyphcastFrames(value);
	if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 60) throw new RangeError("Glyphcast frame rate must be from 1 to 60");
  if (!Number.isInteger(width) || width < 1 || width > 300 || !Number.isInteger(height) || height < 1 || height > 100) {
    throw new RangeError("Glyphcast viewport must be from 1x1 to 300x100");
  }

	const fittedFrames = frames.map((frame) => fitGlyphcastFrame(frame, width, height));
	return createMotionProject({
    width,
    height,
    frameRate,
		durationFrames: fittedFrames.length,
		renderFrame: (frame) => fittedFrames[frame]!,
	});
}

export function parseGlyphcastFrames(value: unknown): readonly string[] {
	if (!isGlyphcastExportV1(value)) throw new RangeError("Expected a Glyphcast v1 export with matching frameCount");
	if (value.frames.length === 0) throw new RangeError("Glyphcast export must contain at least one frame");
	if (value.frames.length > 10_000) throw new RangeError("Glyphcast export contains too many frames");
	for (const frame of value.frames) validateGlyphcastFrame(frame);
	return value.frames;
}

function isGlyphcastExportV1(value: unknown): value is GlyphcastExportV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GlyphcastExportV1>;
  return candidate.version === 1
    && Number.isInteger(candidate.frameCount)
    && Array.isArray(candidate.frames)
    && candidate.frameCount === candidate.frames.length
    && candidate.frames.every((frame) => typeof frame === "string");
}

function fitGlyphcastFrame(frame: string, width: number, height: number): string {
	const source = frame.replace(/\r/g, "").replace(/\n$/, "").split("\n");
	validateGlyphcastFrame(frame);
	let sourceWidth = 0;
	for (const row of source) sourceWidth = Math.max(sourceWidth, row.length);
	if (source.length === 0 || sourceWidth === 0) return blankFrame(width, height);

  const output = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  for (let y = 0; y < height; y++) {
    const fromY = Math.floor(y * source.length / height);
    const toY = Math.max(fromY + 1, Math.floor((y + 1) * source.length / height));
    for (let x = 0; x < width; x++) {
      const fromX = Math.floor(x * sourceWidth / width);
      const toX = Math.max(fromX + 1, Math.floor((x + 1) * sourceWidth / width));
      const counts = new Map<string, number>();
      for (let sy = fromY; sy < toY; sy++) {
        for (let sx = fromX; sx < toX; sx++) {
          const cell = source[sy]?.[sx] ?? " ";
          if (cell !== " ") counts.set(cell, (counts.get(cell) ?? 0) + 1);
        }
      }
      let selected = " ";
      let selectedCount = 0;
      for (const [cell, count] of counts) {
        if (count > selectedCount) {
          selected = cell;
          selectedCount = count;
        }
      }
      output[y]![x] = selected;
    }
  }
  return output.map((row) => row.join("")).join("\n");
}

function validateGlyphcastFrame(frame: string): void {
	const source = frame.replace(/\r/g, "").replace(/\n$/, "").split("\n");
	let sourceWidth = 0;
	for (const row of source) sourceWidth = Math.max(sourceWidth, row.length);
	if (source.length > 10_000 || sourceWidth > 10_000) throw new RangeError("Glyphcast frame dimensions are too large");
	if (source.some((row) => [...row].some((cell) => !isSafeAscii(cell)))) {
		throw new RangeError("Glyphcast frames must contain safe ASCII terminal cells");
	}
}

function blankFrame(width: number, height: number): string {
  return Array.from({ length: height }, () => " ".repeat(width)).join("\n");
}

function isSafeAscii(value: string): boolean {
  const codePoint = value.codePointAt(0)!;
  return codePoint >= 0x20 && codePoint <= 0x7e;
}
