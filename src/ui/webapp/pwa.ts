import { deflateSync } from "node:zlib";

/**
 * PWA assets for the operator surface: manifest, a minimal shell-caching
 * service worker, and dependency-free generated PNG icons.
 */

export const PWA_MANIFEST = {
  name: "Workflow Control",
  short_name: "Workflow",
  description: "Operator surface for Workflow-authorized coding agents",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#101216",
  theme_color: "#101216",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
} as const;

// Avoid backticks here: this string is embedded in a TypeScript template below.
export const PWA_SERVICE_WORKER = [
  'const CACHE = "workflow-shell-__CACHE_VERSION__";',
  'const SHELL = ["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];',
  'self.addEventListener("install", (event) => {',
  "  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));",
  "});",
  'self.addEventListener("activate", (event) => {',
  "  event.waitUntil(",
  "    caches.keys()",
  "      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))",
  "      .then(() => self.clients.claim()),",
  "  );",
  "});",
  'self.addEventListener("fetch", (event) => {',
  "  const url = new URL(event.request.url);",
  "  // Operator data must always be live; the shell is network-first so a",
  "  // rebuilt bundle is never masked by a stale cache — the cache is only",
  "  // the offline fallback.",
  '  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;',
  "  event.respondWith(",
  "    fetch(event.request)",
  "      .then((fresh) => {",
  "        const copy = fresh.clone();",
  "        caches.open(CACHE).then((cache) => cache.put(event.request, copy));",
  "        return fresh;",
  "      })",
  "      .catch(() => caches.match(event.request).then((hit) => hit ?? Response.error())),",
  "  );",
  "});",
  "",
].join("\n");

/**
 * Injects the bundle-derived cache-busting version into the worker source, so
 * every rebuilt bundle retires the previous shell cache on activation.
 */
export function serviceWorkerSource(version: string): string {
  return PWA_SERVICE_WORKER.replace("__CACHE_VERSION__", version.replace(/[^a-z0-9-]/gi, ""));
}

const ICON_BACKGROUND = { r: 0x14, g: 0x16, b: 0x1a } as const;
const ICON_ACCENT = { r: 0xe8, g: 0xa3, b: 0x3d } as const;

/**
 * Renders the Workflow mark (five bars of alternating height) as a raw RGBA
 * PNG of the requested size — no image dependencies required.
 */
export function renderIconPng(size: number): Buffer {
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index++) {
    pixels[index * 4] = ICON_BACKGROUND.r;
    pixels[index * 4 + 1] = ICON_BACKGROUND.g;
    pixels[index * 4 + 2] = ICON_BACKGROUND.b;
    pixels[index * 4 + 3] = 0xff;
  }

  // Five bars forming an abstract workflow mark, centered with even padding.
  const barHeights = [0.6, 0.85, 0.45, 0.85, 0.6];
  const padding = size * 0.18;
  const gutter = size * 0.06;
  const barWidth = (size - padding * 2 - gutter * (barHeights.length - 1)) / barHeights.length;
  for (let bar = 0; bar < barHeights.length; bar++) {
    const height = (size - padding * 2) * barHeights[bar]!;
    const x0 = Math.round(padding + bar * (barWidth + gutter));
    const x1 = Math.round(x0 + barWidth);
    const y1 = Math.round(size - padding);
    const y0 = Math.round(y1 - height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const offset = (y * size + x) * 4;
        pixels[offset] = ICON_ACCENT.r;
        pixels[offset + 1] = ICON_ACCENT.g;
        pixels[offset + 2] = ICON_ACCENT.b;
      }
    }
  }

  return encodePng(size, size, pixels);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.subarray(y * stride, (y + 1) * stride).forEach((value, index) => {
      raw[y * (stride + 1) + 1 + index] = value;
    });
  }
  const compressed = deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const result = Buffer.alloc(8 + data.length + 4);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), 8 + data.length);
  return result;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
