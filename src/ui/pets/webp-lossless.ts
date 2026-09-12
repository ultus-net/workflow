
/**
 * Minimal WebP lossless (VP8L) decoder implementing RFC 9649 Section 3
 * (https://www.rfc-editor.org/rfc/rfc9649.html#section-3). Only the RIFF
 * simple lossless container is supported; lossy VP8 and extended (VP8X)
 * containers are rejected with an explicit error.
 */

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

const MAX_DIMENSION = 16384;
const MAX_CODE_LENGTH = 15;

class BitReader {
  private bitPos = 0;
  constructor(private readonly bytes: Uint8Array, private readonly length: number) {}
  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byteIndex = (this.bitPos + i) >> 3;
      if (byteIndex >= this.length) throw new Error("VP8L: bit reader out of data");
      value |= ((this.bytes[byteIndex]! >> ((this.bitPos + i) & 7)) & 1) << i;
    }
    this.bitPos += count;
    return value;
  }
}

interface HuffmanTree {
  codes: Array<{ code: number; length: number; symbol: number }>;
}

function bitReverse(code: number, length: number): number {
  let out = 0;
  for (let i = 0; i < length; i++) {
    out = (out << 1) | (code & 1);
    code >>= 1;
  }
  return out;
}

function buildCanonicalTree(lengths: Int32Array): HuffmanTree {
  const counts = new Array<number>(MAX_CODE_LENGTH + 1).fill(0);
  for (const len of lengths) counts[len]!++;
  if (counts[0] === lengths.length) {
    return { codes: [{ code: 0, length: 0, symbol: 0 }] };
  }
  if (counts[0] === lengths.length - 1) {
    const symbol = lengths.findIndex((len) => len !== 0);
    return { codes: [{ code: 0, length: 0, symbol }] };
  }
  const entries: Array<{ code: number; length: number; symbol: number }> = [];
  let code = 0;
  for (let len = 1; len <= MAX_CODE_LENGTH; len++) {
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      if (lengths[symbol] === len) {
        // VP8L stores canonical codes bit-reversed in the stream.
        entries.push({ code: bitReverse(code, len), length: len, symbol });
        code++;
      }
    }
    code = (code << 1) >>> 0;
  }
  return { codes: entries };
}

function readSymbol(reader: BitReader, tree: HuffmanTree): number {
  let code = 0;
  let length = 0;
  for (const entry of tree.codes) {
    while (length < entry.length) {
      code |= reader.readBits(1) << length;
      length++;
    }
    if (code === entry.code) return entry.symbol;
  }
  throw new Error("VP8L: invalid prefix code symbol");
}

type HuffmanGroup = HuffmanTree[];

const DISTANCE_MAP: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 0], [1, 1], [-1, 1], [0, 2], [2, 0], [1, 2], [-1, 2],
  [2, 1], [-2, 1], [2, 2], [-2, 2], [0, 3], [3, 0], [1, 3], [-1, 3],
  [3, 1], [-3, 1], [2, 3], [-2, 3], [3, 2], [-3, 2], [0, 4], [4, 0],
  [1, 4], [-1, 4], [4, 1], [-4, 1], [3, 3], [-3, 3], [2, 4], [-2, 4],
  [4, 2], [-4, 2], [0, 5], [3, 4], [-3, 4], [4, 3], [-4, 3], [5, 0],
  [1, 5], [-1, 5], [5, 1], [-5, 1], [2, 5], [-2, 5], [5, 2], [-5, 2],
  [4, 4], [-4, 4], [3, 5], [-3, 5], [5, 3], [-5, 3], [0, 6], [6, 0],
  [1, 6], [-1, 6], [6, 1], [-6, 1], [2, 6], [-2, 6], [6, 2], [-6, 2],
  [4, 5], [-4, 5], [5, 4], [-5, 4], [3, 6], [-3, 6], [6, 3], [-6, 3],
  [0, 7], [7, 0], [1, 7], [-1, 7], [5, 5], [-5, 5], [7, 1], [-7, 1],
  [4, 6], [-4, 6], [6, 4], [-6, 4], [2, 7], [-2, 7], [7, 2], [-7, 2],
  [3, 7], [-3, 7], [7, 3], [-7, 3], [5, 6], [-5, 6], [6, 5], [-6, 5],
  [8, 0], [4, 7], [-4, 7], [7, 4], [-7, 4], [8, 1], [8, 2], [6, 6],
  [-6, 6], [8, 3], [5, 7], [-5, 7], [7, 5], [-7, 5], [8, 4], [6, 7],
  [-6, 7], [7, 6], [-7, 6], [8, 5], [7, 7], [-7, 7], [8, 6], [8, 7],
];

const ALPHA = (p: number) => (p >>> 24) & 0xff;
const RED = (p: number) => (p >>> 16) & 0xff;
const GREEN = (p: number) => (p >>> 8) & 0xff;
const BLUE = (p: number) => p & 0xff;

function subSampleSize(size: number, bits: number): number {
  return (size + (1 << bits) - 1) >> bits;
}

function readPrefixCode(reader: BitReader, alphabetSize: number): HuffmanTree {
  if (reader.readBits(1) === 1) {
    const codeLengths = new Int32Array(alphabetSize);
    const numSymbols = reader.readBits(1) + 1;
    const first8 = reader.readBits(1);
    const symbol0 = reader.readBits(first8 === 1 ? 8 : 1);
    if (symbol0 >= alphabetSize) throw new Error("VP8L: simple symbol out of range");
    codeLengths[symbol0] = 1;
    if (numSymbols === 2) {
      const symbol1 = reader.readBits(8);
      if (symbol1 >= alphabetSize) throw new Error("VP8L: simple symbol out of range");
      codeLengths[symbol1] = 1;
    }
    return buildCanonicalTree(codeLengths);
  }

  const codeLengthCodeLengths = new Int32Array(19);
  const order = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const numCodeLengths = 4 + reader.readBits(4);
  for (let i = 0; i < numCodeLengths; i++) codeLengthCodeLengths[order[i]!] = reader.readBits(3);
  const codeLengthTree = buildCanonicalTree(codeLengthCodeLengths);

  let maxSymbol = alphabetSize;
  if (reader.readBits(1) === 1) {
    const nbits = 2 + 2 * reader.readBits(3);
    maxSymbol = 2 + reader.readBits(nbits);
    if (maxSymbol > alphabetSize) throw new Error("VP8L: max_symbol too large");
  }

  const lengths = new Int32Array(alphabetSize);
  let previous = 8;
  let symbol = 0;
  let remaining = maxSymbol;
  while (symbol < alphabetSize && remaining > 0) {
    remaining--;
    const lengthCode = readSymbol(reader, codeLengthTree);
    if (lengthCode < 16) {
      if (lengthCode !== 0) previous = lengthCode;
      lengths[symbol] = lengthCode;
      symbol++;
      continue;
    }
    let repeat: number;
    let value: number;
    if (lengthCode === 16) {
      repeat = 3 + reader.readBits(2);
      value = previous;
    } else {
      repeat = lengthCode === 17 ? 3 + reader.readBits(3) : 11 + reader.readBits(7);
      value = 0;
    }
    if (symbol + repeat > alphabetSize) throw new Error("VP8L: repeat overflow");
    while (repeat-- > 0) lengths[symbol++] = value;
  }
  return buildCanonicalTree(lengths);
}

function insertCache(cache: Uint32Array, bits: number, pixel: number): void {
  cache[(Math.imul(0x1e35a7bd, pixel) >>> (32 - bits))] = pixel;
}

function decodeARGBImage(reader: BitReader, width: number, height: number, allowMetas: boolean): Int32Array {
  const cacheFlag = reader.readBits(1);
  const cacheBits = cacheFlag === 1 ? (() => {
    const bits = reader.readBits(4);
    if (bits < 1 || bits > 11) throw new Error(`VP8L: invalid color cache bits ${bits}`);
    return bits;
  })() : 0;

  let groupCount = 1;
  let metaBits = 0;
  let metaWidth = 0;
  let metaImage: Int32Array | undefined;
  // libwebp: the meta flag bit is consumed only when recursion is allowed
  // (main ARGB image). Substreams have no meta flag bit at all.
  const metaPresent = allowMetas ? reader.readBits(1) : 0;
  if (metaPresent === 1) {
    metaBits = reader.readBits(3) + 2;
    metaWidth = subSampleSize(width, metaBits);
    metaImage = decodeARGBImage(reader, metaWidth, subSampleSize(height, metaBits), false);
    for (const pixel of metaImage) groupCount = Math.max(groupCount, ((pixel >>> 8) & 0xffff) + 1);
  }

  const alphabetGreen = 256 + 24 + (cacheBits > 0 ? (1 << cacheBits) : 0);
  const groups: HuffmanGroup[] = [];
  for (let g = 0; g < groupCount; g++) {
    groups.push([
      readPrefixCode(reader, alphabetGreen),
      readPrefixCode(reader, 256),
      readPrefixCode(reader, 256),
      readPrefixCode(reader, 256),
      readPrefixCode(reader, 40),
    ]);
  }

  const pixels = new Int32Array(width * height);
  const cache = cacheBits > 0 ? new Uint32Array(1 << cacheBits) : undefined;
  let index = 0;
  while (index < pixels.length) {
    let group = groups[0]!;
    if (metaImage !== undefined) {
      const x = index % width;
      const y = (index / width) | 0;
      const meta = (metaImage[(y >> metaBits) * metaWidth + (x >> metaBits)]! >>> 8) & 0xffff;
      group = groups[meta]!;
    }
    const symbol = readSymbol(reader, group[0]!);
    if (symbol < 256) {
      const green = symbol & 0xff;
      const red = readSymbol(reader, group[1]!) & 0xff;
      const blue = readSymbol(reader, group[2]!) & 0xff;
      const alpha = readSymbol(reader, group[3]!) & 0xff;
      const pixel = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
      pixels[index] = pixel;
      if (cache !== undefined) insertCache(cache, cacheBits, pixel);
      index++;
      continue;
    }
    if (symbol < 256 + 24) {
      const length = readLz77Value(reader, symbol - 256);
      const distancePrefix = readSymbol(reader, group[4]!);
      const distance = readDistance(reader, distancePrefix, width);
      if (index + length > pixels.length) throw new Error("VP8L: backward reference overflow");
      for (let k = 0; k < length; k++) {
        const pixel = pixels[index - distance]!;
        pixels[index] = pixel;
        if (cache !== undefined) insertCache(cache, cacheBits, pixel);
        index++;
      }
      continue;
    }
    if (cache === undefined) throw new Error("VP8L: color cache code without cache");
    const pixel = cache[symbol - 256 - 24]!;
    pixels[index] = pixel;
    insertCache(cache, cacheBits, pixel);
    index++;
  }
  return pixels;
}

function readLz77Value(reader: BitReader, prefixCode: number): number {
  if (prefixCode < 4) return prefixCode + 1;
  if (prefixCode > 39) throw new Error("VP8L: invalid LZ77 prefix code");
  const extraBits = (prefixCode - 2) >> 1;
  const offset = (2 + (prefixCode & 1)) << extraBits;
  return offset + reader.readBits(extraBits) + 1;
}

function readDistance(reader: BitReader, prefixCode: number, width: number): number {
  const value = readLz77Value(reader, prefixCode);
  if (value > 120) return value - 120;
  const [xi, yi] = DISTANCE_MAP[(value - 1) % DISTANCE_MAP.length]!;
  const dist = xi + yi * width;
  return dist < 1 ? 1 : dist;
}

interface Transform {
  type: number;
  bits: number;
  data: Int32Array;
  tableSize: number;
}

interface ImageHeader {
  width: number;
  height: number;
}

function readImageHeader(reader: BitReader): ImageHeader {
  if (reader.readBits(8) !== 0x2f) throw new Error("VP8L: bad signature");
  const width = reader.readBits(14) + 1;
  const height = reader.readBits(14) + 1;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error("VP8L: invalid dimensions");
  reader.readBits(1);
  if (reader.readBits(3) !== 0) throw new Error("VP8L: unsupported version");
  return { width, height };
}

function toSigned8(v: number): number { return v >= 128 ? v - 256 : v; }
function colorDelta(t: number, c: number): number { return (toSigned8(t) * toSigned8(c)) >> 5; }
function clampChannel(sum: number): number { return sum < 0 ? 0 : sum > 255 ? 255 : sum; }

function predictSelect(l: number, t: number, tl: number): number {
  const dist = (sel: number) => {
    let sum = 0;
    for (let i = 0; i < 32; i += 8) {
      const estimate = ((l >>> i) & 0xff) + ((t >>> i) & 0xff) - ((tl >>> i) & 0xff);
      sum += Math.abs(estimate - ((sel >>> i) & 0xff));
    }
    return sum;
  };
  return dist(l) < dist(t) ? l : t;
}

function clampFSum(a: number, b: number, c: number): number {
  let out = 0;
  for (let i = 0; i < 32; i += 8) out |= clampChannel(((a >>> i) & 0xff) + ((b >>> i) & 0xff) - ((c >>> i) & 0xff)) << i;
  return out >>> 0;
}

function clampHSum(a: number, b: number): number {
  let out = 0;
  for (let i = 0; i < 32; i += 8) {
    const av = (a >>> i) & 0xff;
    const diff = av - ((b >>> i) & 0xff);
    // C-style truncation toward zero before addition (RFC 3.5.1).
    const half = diff >= 0 ? diff >> 1 : -((-diff) >> 1);
    out |= clampChannel(av + half) << i;
  }
  return out >>> 0;
}

function average2(a: number, b: number): number {
  let out = 0;
  for (let i = 0; i < 32; i += 8) out |= ((((a >>> i) & 0xff) + ((b >>> i) & 0xff)) >> 1) << i;
  return out >>> 0;
}

function predict(mode: number, l: number, t: number, tl: number, tr: number): number {
  switch (mode) {
    case 0: return 0xff000000;
    case 1: return l;
    case 2: return t;
    case 3: return tr;
    case 4: return tl;
    case 5: return average2(average2(l, tr), t);
    case 6: return average2(l, tl);
    case 7: return average2(l, t);
    case 8: return average2(tl, t);
    case 9: return average2(t, tr);
    case 10: return average2(average2(l, tl), average2(t, tr));
    case 11: return predictSelect(l, t, tl);
    case 12: return clampFSum(l, t, tl);
    case 13: return clampHSum(average2(l, t), tl);
    default: throw new Error(`VP8L: invalid predictor mode ${mode}`);
  }
}

function readTransform(reader: BitReader, type: number, imageWidth: number, imageHeight: number): { transform: Transform; width: number } {
  if (type === 2) return { transform: { type, bits: 0, data: new Int32Array(0), tableSize: 0 }, width: imageWidth };
  if (type === 3) {
    const tableSize = reader.readBits(8) + 1;
    const table = decodeARGBImage(reader, tableSize, 1, false);
    // RFC 3.5.4: color table entries are delta-encoded; accumulate per channel.
    for (let i = 1; i < tableSize; i++) {
      const p = table[i - 1]!;
      const d = table[i]!;
      table[i] = (((ALPHA(p) + ALPHA(d)) & 0xff) << 24) | (((RED(p) + RED(d)) & 0xff) << 16) | (((GREEN(p) + GREEN(d)) & 0xff) << 8) | ((BLUE(p) + BLUE(d)) & 0xff);
    }
    const widthBits = tableSize <= 2 ? 3 : tableSize <= 4 ? 2 : tableSize <= 16 ? 1 : 0;
    return { transform: { type, bits: widthBits, data: table, tableSize }, width: subSampleSize(imageWidth, widthBits) };
  }
  const bits = reader.readBits(3) + 2;
  const data = decodeARGBImage(reader, subSampleSize(imageWidth, bits), subSampleSize(imageHeight, bits), false);
  return { transform: { type, bits, data, tableSize: 0 }, width: imageWidth };
}

function applyPredictor(pixels: Int32Array, width: number, height: number, transform: Transform): void {
  const tilesPerRow = subSampleSize(width, transform.bits);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const mode = (transform.data[(y >> transform.bits) * tilesPerRow + (x >> transform.bits)]! >>> 8) & 0xff;
      let pred: number;
      if (y === 0 && x === 0) pred = 0xff000000;
      else if (y === 0) pred = pixels[index - 1]!;
      else if (x === 0) pred = pixels[index - width]!;
      else {
        // RFC 3.5.1: on the rightmost column, TR is the leftmost pixel of
        // the current row.
        const tr = x === width - 1 ? pixels[y * width]! : pixels[index - width + 1]!;
        pred = predict(mode, pixels[index - 1]!, pixels[index - width]!, pixels[index - width - 1]!, tr);
      }
      const r = pixels[index]!;
      pixels[index] = (((ALPHA(r) + ALPHA(pred)) & 0xff) << 24) | (((RED(r) + RED(pred)) & 0xff) << 16) | (((GREEN(r) + GREEN(pred)) & 0xff) << 8) | ((BLUE(r) + BLUE(pred)) & 0xff);
    }
  }
}

function applyColor(pixels: Int32Array, width: number, height: number, transform: Transform): void {
  const tilesPerRow = subSampleSize(width, transform.bits);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const cte = transform.data[(y >> transform.bits) * tilesPerRow + (x >> transform.bits)]!;
      const greenToRed = BLUE(cte);
      const greenToBlue = GREEN(cte);
      const redToBlue = RED(cte);
      const p = pixels[index]!;
      const green = GREEN(p);
      const red = (RED(p) + colorDelta(greenToRed, green)) & 0xff;
      let blue = (BLUE(p) + colorDelta(greenToBlue, green)) & 0xff;
      blue = (blue + colorDelta(redToBlue, red)) & 0xff;
      pixels[index] = (p & 0xff00ff00) | (red << 16) | blue;
    }
  }
}

function applySubtractGreen(pixels: Int32Array): void {
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    pixels[i] = (p & 0xff00ff00) | (((RED(p) + GREEN(p)) & 0xff) << 16) | ((BLUE(p) + GREEN(p)) & 0xff);
  }
}

function applyIndexing(pixels: Int32Array, width: number, height: number, originalWidth: number, transform: Transform): { pixels: Int32Array; width: number } {
  if (transform.bits === 0) {
    for (let i = 0; i < pixels.length; i++) {
      const idx = (pixels[i]! >>> 8) & 0xff;
      pixels[i] = idx < transform.tableSize ? transform.data[idx]! : 0;
    }
    return { pixels, width: originalWidth };
  }
  const perPixel = 1 << transform.bits;
  const bitsPerIndex = 8 / perPixel;
  const mask = (1 << bitsPerIndex) - 1;
  const out = new Int32Array(originalWidth * height);
  for (let y = 0; y < height; y++) {
    for (let bundle = 0; bundle < width; bundle++) {
      const packed = (pixels[y * width + bundle]! >>> 8) & 0xff;
      for (let s = 0; s < perPixel; s++) {
        const x = bundle * perPixel + s;
        if (x >= originalWidth) break;
        const idx = (packed >> (s * bitsPerIndex)) & mask;
        out[y * originalWidth + x] = idx < transform.tableSize ? transform.data[idx]! : 0;
      }
    }
  }
  return { pixels: out, width: originalWidth };
}

function findVp8lChunk(bytes: Uint8Array): { offset: number; length: number } {
  if (bytes.length < 12) throw new Error("VP8L: not a RIFF WebP container");
  if (!(bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)) throw new Error("VP8L: missing RIFF header");
  if (!(bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)) throw new Error("VP8L: missing WEBP form type");
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24);
    if (tag === "VP8 ") throw new Error("VP8L: lossy VP8 spritesheets are not supported");
    if (tag === "VP8L") {
      if (offset + 8 + size > bytes.length) throw new Error("VP8L: truncated chunk");
      return { offset: offset + 8, length: size };
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error("VP8L: no lossless image chunk found");
}

export function decodeWebpLossless(bytes: Uint8Array): DecodedImage {
  const { offset, length } = findVp8lChunk(bytes);
  const reader = new BitReader(bytes.subarray(offset, offset + length), length);
  return decodeStream(reader);
}

function decodeStream(reader: BitReader): DecodedImage {
  const header = readImageHeader(reader);
  const transforms: Transform[] = [];
  const seen = new Set<number>();
  let width = header.width;
  while (reader.readBits(1) === 1) {
    const type = reader.readBits(2);
    if (seen.has(type)) throw new Error("VP8L: duplicate transform");
    seen.add(type);
    const result = readTransform(reader, type, width, header.height);
    transforms.push(result.transform);
    width = result.width;
  }
  let pixels = decodeARGBImage(reader, width, header.height, true);
  for (let i = transforms.length - 1; i >= 0; i--) {
    const transform = transforms[i]!;
    if (transform.type === 0) applyPredictor(pixels, width, header.height, transform);
    else if (transform.type === 1) applyColor(pixels, width, header.height, transform);
    else if (transform.type === 2) applySubtractGreen(pixels);
    else if (transform.type === 3) {
      const result = applyIndexing(pixels, width, header.height, header.width, transform);
      pixels = result.pixels;
      width = result.width;
    }
  }
  const rgba = new Uint8ClampedArray(width * header.height * 4);
  for (let i = 0; i < width * header.height; i++) {
    const pixel = pixels[i]!;
    rgba[i * 4] = RED(pixel);
    rgba[i * 4 + 1] = GREEN(pixel);
    rgba[i * 4 + 2] = BLUE(pixel);
    rgba[i * 4 + 3] = ALPHA(pixel);
  }
  return { width, height: header.height, rgba };
}

