import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeWebpLossless } from "../src/ui/pets/webp-lossless.js";

const fixture = (name: string): Uint8Array => {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return new Uint8Array(readFileSync(fileURLToPath(url)));
};

test("decodeWebpLossless decodes a 4x4 RGBA lossless WebP", () => {
  const bytes = fixture("tiny4x4.webp");
  const expectation = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/tiny4x4.json", import.meta.url)), "utf8")) as { width: number; height: number; pixels: number[][] };
  const image = decodeWebpLossless(bytes);
  assert.equal(image.width, expectation.width);
  assert.equal(image.height, expectation.height);
  assert.equal(image.rgba.length, expectation.width * expectation.height * 4);
  for (let pixel = 0; pixel < expectation.width * expectation.height; pixel++) {
    const expected = expectation.pixels[pixel]!;
    assert.deepEqual(
      [image.rgba[pixel * 4], image.rgba[pixel * 4 + 1], image.rgba[pixel * 4 + 2], image.rgba[pixel * 4 + 3]],
      expected,
      `pixel ${pixel}`,
    );
  }
});

test("decodeWebpLossless decodes a single-color WebP", () => {
  const image = decodeWebpLossless(fixture("plain.webp"));
  assert.equal(image.width, 4);
  assert.equal(image.height, 4);
  for (let pixel = 0; pixel < 16; pixel++) {
    assert.deepEqual(
      [image.rgba[pixel * 4], image.rgba[pixel * 4 + 1], image.rgba[pixel * 4 + 2], image.rgba[pixel * 4 + 3]],
      [10, 10, 10, 255],
      `pixel ${pixel}`,
    );
  }
});

test("decodeWebpLossless decodes a real Petdex spritesheet bit-exactly", () => {
  const image = decodeWebpLossless(fixture("cat.webp"));
  assert.equal(image.width, 1536);
  assert.equal(image.height, 1872);
  const digest = createHash("sha256").update(Buffer.from(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength)).digest("hex");
  assert.equal(digest, "50a2a9ef5c4cd245569d1bff7f3bf351dd7d76c8ca735571a979c36875f6c431");
});

test("decodeWebpLossless rejects non-RIFF data", () => {
  assert.throws(() => decodeWebpLossless(new Uint8Array([1, 2, 3])), /RIFF/);
});

test("decodeWebpLossless rejects lossy VAU-only payloads", () => {
  const header = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(() => decodeWebpLossless(header), /VP8L/);
});
