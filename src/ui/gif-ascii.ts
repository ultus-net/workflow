import { decompressFrames, parseGIF } from "gifuct-js";

const DEFAULT_DENSITY_RAMP = " .:-=+*#%@";

export interface GifAsciiAnimation {
  frames: string[];
  delays: number[];
  width: number;
  height: number;
}

export function fitGifToTerminal(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const terminalCellAspect = 2;
  const width = Math.max(1, Math.min(maxWidth, Math.round(maxHeight * sourceWidth * terminalCellAspect / sourceHeight)));
  const height = Math.max(1, Math.min(maxHeight, Math.round(width * sourceHeight / (sourceWidth * terminalCellAspect))));
  return { width, height };
}

export function rgbaToAscii(
  rgba: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  densityRamp = DEFAULT_DENSITY_RAMP,
): string {
  if (rgba.length !== sourceWidth * sourceHeight * 4) throw new RangeError("RGBA dimensions do not match pixel data");
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every((value) => Number.isInteger(value) && value > 0)) {
    throw new RangeError("image dimensions must be positive integers");
  }
  if (densityRamp.length < 2 || !/^[\x20-\x7e]+$/.test(densityRamp)) throw new RangeError("density ramp must contain safe ASCII");

  const rows: string[] = [];
  for (let y = 0; y < targetHeight; y++) {
    let row = "";
    const y0 = y * sourceHeight / targetHeight;
    const y1 = (y + 1) * sourceHeight / targetHeight;
    for (let x = 0; x < targetWidth; x++) {
      const x0 = x * sourceWidth / targetWidth;
      const x1 = (x + 1) * sourceWidth / targetWidth;
      let luminance = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const yWeight = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const weight = yWeight * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const offset = (sy * sourceWidth + sx) * 4;
          const alpha = rgba[offset + 3]! / 255;
          const pixelLuminance = (0.2126 * rgba[offset]! + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!) * alpha + 255 * (1 - alpha);
          luminance += pixelLuminance * weight;
          area += weight;
        }
      }
      const normalized = luminance / (area * 255);
      row += densityRamp[Math.round(normalized * (densityRamp.length - 1))]!;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

export function rgbaToAnsiHalfBlocks(
  rgba: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): string {
  if (rgba.length !== sourceWidth * sourceHeight * 4) throw new RangeError("RGBA dimensions do not match pixel data");
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every((value) => Number.isInteger(value) && value > 0)) {
    throw new RangeError("image dimensions must be positive integers");
  }

  const rows: string[] = [];
  for (let y = 0; y < targetHeight; y++) {
    let row = "";
    for (let x = 0; x < targetWidth; x++) {
      const top = sampleRgba(rgba, sourceWidth, sourceHeight, x, y * 2, targetWidth, targetHeight * 2);
      const bottom = sampleRgba(rgba, sourceWidth, sourceHeight, x, y * 2 + 1, targetWidth, targetHeight * 2);
      if (!top && !bottom) {
        row += " ";
      } else if (!bottom) {
        row += `\x1b[38;2;${top!.join(";")}m▀\x1b[0m`;
      } else if (!top) {
        row += `\x1b[38;2;${bottom.join(";")}m▄\x1b[0m`;
      } else {
        row += `\x1b[38;2;${top.join(";")}m\x1b[48;2;${bottom.join(";")}m▀\x1b[0m`;
      }
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function sampleRgba(
  rgba: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  targetWidth: number,
  targetHeight: number,
): [number, number, number] | undefined {
  const x0 = x * sourceWidth / targetWidth;
  const x1 = (x + 1) * sourceWidth / targetWidth;
  const y0 = y * sourceHeight / targetHeight;
  const y1 = (y + 1) * sourceHeight / targetHeight;
  let red = 0;
  let green = 0;
  let blue = 0;
  let alphaArea = 0;
  let area = 0;
  for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
    const yWeight = Math.min(y1, sy + 1) - Math.max(y0, sy);
    for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      const weight = yWeight * (Math.min(x1, sx + 1) - Math.max(x0, sx));
      const offset = (sy * sourceWidth + sx) * 4;
      const alphaWeight = weight * rgba[offset + 3]! / 255;
      red += rgba[offset]! * alphaWeight;
      green += rgba[offset + 1]! * alphaWeight;
      blue += rgba[offset + 2]! * alphaWeight;
      alphaArea += alphaWeight;
      area += weight;
    }
  }
  if (alphaArea < area / 10) return undefined;
  return [Math.round(red / alphaArea), Math.round(green / alphaArea), Math.round(blue / alphaArea)];
}

export function gifToAsciiAnimation(data: Uint8Array, maxWidth: number, maxHeight: number): GifAsciiAnimation {
  return decodeGifAnimation(data, maxWidth, maxHeight, rgbaToAscii);
}

export function gifToAnsiHalfBlockAnimation(data: Uint8Array, maxWidth: number, maxHeight: number): GifAsciiAnimation {
  return decodeGifAnimation(data, maxWidth, maxHeight, rgbaToAnsiHalfBlocks, true);
}

function decodeGifAnimation(
  data: Uint8Array,
  maxWidth: number,
  maxHeight: number,
  render: (rgba: Uint8ClampedArray, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) => string,
  cropTransparency = false,
): GifAsciiAnimation {
  if (data.byteLength > 25 * 1024 * 1024) throw new RangeError("GIF data is too large");
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const gif = parseGIF(bytes);
  if (gif.lsd.width < 1 || gif.lsd.height < 1 || gif.lsd.width > 4096 || gif.lsd.height > 4096 || gif.lsd.width * gif.lsd.height > 16_000_000) {
    throw new RangeError("GIF dimensions are out of range");
  }
  const sourceFrames = gif.frames.filter((frame) => "image" in frame);
  if (sourceFrames.length < 1 || sourceFrames.length > 120) throw new RangeError("GIF frame count is out of range");
  const decodedPixels = sourceFrames.reduce((total, frame) => total + frame.image.descriptor.width * frame.image.descriptor.height, 0);
  if (sourceFrames.some((frame) => frame.image.descriptor.width * frame.image.descriptor.height > 16_000_000) || decodedPixels > 32_000_000) {
    throw new RangeError("GIF frame dimensions are out of range");
  }
  const decoded = decompressFrames(gif, true);

  const crop = cropTransparency ? findAnimationBounds(decoded) : { left: 0, top: 0, width: gif.lsd.width, height: gif.lsd.height };
  const { width, height } = fitGifToTerminal(crop.width, crop.height, maxWidth, maxHeight);
  const canvas = new Uint8ClampedArray(gif.lsd.width * gif.lsd.height * 4);
  const frames: string[] = [];
  const delays: number[] = [];
  let previousDisposal = 0;
  let previousDims = decoded[0]!.dims;
  let restoreCanvas: Uint8ClampedArray | undefined;

  for (let index = 0; index < decoded.length; index++) {
    const frame = decoded[index]!;
    if (previousDisposal === 2) clearRegion(canvas, gif.lsd.width, gif.lsd.height, previousDims);
    if (previousDisposal === 3 && restoreCanvas) canvas.set(restoreCanvas);
    restoreCanvas = frame.disposalType === 3 ? canvas.slice() : undefined;
    compositePatch(canvas, gif.lsd.width, gif.lsd.height, frame.patch, frame.dims);
    const pixels = cropTransparency ? cropRgba(canvas, gif.lsd.width, crop) : canvas;
    frames.push(render(pixels, crop.width, crop.height, width, height));
    delays.push((sourceFrames[index]!.gce?.delay ?? 0) * 10);
    previousDisposal = frame.disposalType;
    previousDims = frame.dims;
  }
  return { frames, delays, width, height };
}

function findAnimationBounds(frames: Array<{ dims: { left: number; top: number; width: number; height: number }; patch: Uint8ClampedArray }>): { left: number; top: number; width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (const frame of frames) {
    for (let y = 0; y < frame.dims.height; y++) for (let x = 0; x < frame.dims.width; x++) {
      if (frame.patch[(y * frame.dims.width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, frame.dims.left + x);
      top = Math.min(top, frame.dims.top + y);
      right = Math.max(right, frame.dims.left + x);
      bottom = Math.max(bottom, frame.dims.top + y);
    }
  }
  if (right < left || bottom < top) return { left: 0, top: 0, width: 1, height: 1 };
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function cropRgba(rgba: Uint8ClampedArray, sourceWidth: number, crop: { left: number; top: number; width: number; height: number }): Uint8ClampedArray {
  const output = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    const sourceStart = ((crop.top + y) * sourceWidth + crop.left) * 4;
    output.set(rgba.subarray(sourceStart, sourceStart + crop.width * 4), y * crop.width * 4);
  }
  return output;
}

function compositePatch(canvas: Uint8ClampedArray, width: number, height: number, patch: Uint8ClampedArray, dims: { left: number; top: number; width: number; height: number }): void {
  for (let y = 0; y < dims.height; y++) for (let x = 0; x < dims.width; x++) {
    const dx = dims.left + x;
    const dy = dims.top + y;
    if (dx < 0 || dx >= width || dy < 0 || dy >= height) continue;
    const source = (y * dims.width + x) * 4;
    if (patch[source + 3] === 0) continue;
    const target = (dy * width + dx) * 4;
    canvas.set(patch.subarray(source, source + 4), target);
  }
}

function clearRegion(canvas: Uint8ClampedArray, width: number, height: number, dims: { left: number; top: number; width: number; height: number }): void {
  const left = Math.max(0, dims.left);
  const right = Math.min(width, dims.left + dims.width);
  const top = Math.max(0, dims.top);
  const bottom = Math.min(height, dims.top + dims.height);
  for (let y = top; y < bottom; y++) {
    const start = (y * width + left) * 4;
    canvas.fill(0, start, (y * width + right) * 4);
  }
}
