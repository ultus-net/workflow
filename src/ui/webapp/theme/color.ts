/**
 * OKLab/OKLCH color math for the palette engine.
 *
 * The OKLab matrices are Björn Ottosson's published constants
 * (bottosson.github.io/posts/color oklab conversions) — the same constants
 * OpenCode's MIT-licensed theme engine uses
 * (github.com/sst/opencode, packages/ui/src/theme/color.ts); this port
 * restores them in full and adapts the helper set to Workflow's needs.
 */

export type HexColor = `#${string}`;
export interface OklchColor {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const hue = (value: number): number => ((value % 360) + 360) % 360;

export function hexToRgb(hex: HexColor): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  const rgb = full.length === 8 ? full.slice(0, 6) : full;
  const num = parseInt(rgb, 16);
  return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
}

export function rgbToHex(r: number, g: number, b: number): HexColor {
  const toHex = (v: number): string => {
    const int = Math.round(clamp(v, 0, 1) * 255);
    return int.toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// Linear sRGB -> LMS (Ottosson OKLab matrix 1).
const OKLAB_LMS: ReadonlyArray<readonly [number, number, number]> = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
// LMS' -> OKLab (matrix 2).
const OKLAB_LMS_TO_LAB: ReadonlyArray<readonly [number, number, number]> = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
// OKLab -> LMS' (matrix 3).
const OKLAB_LAB_TO_LMS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
// LMS' -> linear sRGB (matrix 4).
const OKLAB_LMS_TO_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

export function rgbToOklch(r: number, g: number, b: number): OklchColor {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l_ = OKLAB_LMS[0]![0]! * lr + OKLAB_LMS[0]![1]! * lg + OKLAB_LMS[0]![2]! * lb;
  const m_ = OKLAB_LMS[1]![0]! * lr + OKLAB_LMS[1]![1]! * lg + OKLAB_LMS[1]![2]! * lb;
  const s_ = OKLAB_LMS[2]![0]! * lr + OKLAB_LMS[2]![1]! * lg + OKLAB_LMS[2]![2]! * lb;

  const l = Math.cbrt(l_);
  const m = Math.cbrt(m_);
  const s = Math.cbrt(s_);

  const L = OKLAB_LMS_TO_LAB[0]![0]! * l + OKLAB_LMS_TO_LAB[0]![1]! * m + OKLAB_LMS_TO_LAB[0]![2]! * s;
  const a = OKLAB_LMS_TO_LAB[1]![0]! * l + OKLAB_LMS_TO_LAB[1]![1]! * m + OKLAB_LMS_TO_LAB[1]![2]! * s;
  const bOk = OKLAB_LMS_TO_LAB[2]![0]! * l + OKLAB_LMS_TO_LAB[2]![1]! * m + OKLAB_LMS_TO_LAB[2]![2]! * s;

  const C = Math.sqrt(a * a + bOk * bOk);
  const H = hue(Math.atan2(bOk, a) * (180 / Math.PI));
  return { l: L, c: C, h: H };
}

export function oklchToRgb(oklch: OklchColor): { r: number; g: number; b: number } {
  const { l: L, c: C, h: H } = oklch;
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);

  const l = OKLAB_LAB_TO_LMS[0]![0]! * L + OKLAB_LAB_TO_LMS[0]![1]! * a + OKLAB_LAB_TO_LMS[0]![2]! * b;
  const m = OKLAB_LAB_TO_LMS[1]![0]! * L + OKLAB_LAB_TO_LMS[1]![1]! * a + OKLAB_LAB_TO_LMS[1]![2]! * b;
  const s = OKLAB_LAB_TO_LMS[2]![0]! * L + OKLAB_LAB_TO_LMS[2]![1]! * a + OKLAB_LAB_TO_LMS[2]![2]! * b;

  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  const lr = OKLAB_LMS_TO_RGB[0]![0]! * l3 + OKLAB_LMS_TO_RGB[0]![1]! * m3 + OKLAB_LMS_TO_RGB[0]![2]! * s3;
  const lg = OKLAB_LMS_TO_RGB[1]![0]! * l3 + OKLAB_LMS_TO_RGB[1]![1]! * m3 + OKLAB_LMS_TO_RGB[1]![2]! * s3;
  const lb = OKLAB_LMS_TO_RGB[2]![0]! * l3 + OKLAB_LMS_TO_RGB[2]![1]! * m3 + OKLAB_LMS_TO_RGB[2]![2]! * s3;

  return { r: linearToSrgb(lr), g: linearToSrgb(lg), b: linearToSrgb(lb) };
}

export function hexToOklch(hex: HexColor): OklchColor {
  const { r, g, b } = hexToRgb(hex);
  return rgbToOklch(r, g, b);
}

/** Pulls chroma into gamut instead of letting RGB clamp distort lightness. */
export function fitOklch(oklch: OklchColor): OklchColor {
  const base = { l: clamp(oklch.l, 0, 1), c: Math.max(0, oklch.c), h: hue(oklch.h) };
  const rgb = oklchToRgb(base);
  if (rgb.r >= 0 && rgb.r <= 1 && rgb.g >= 0 && rgb.g <= 1 && rgb.b >= 0 && rgb.b <= 1) return base;
  let c = base.c;
  for (let i = 0; i < 24; i++) {
    c *= 0.9;
    const out = oklchToRgb({ ...base, c });
    if (out.r >= 0 && out.r <= 1 && out.g >= 0 && out.g <= 1 && out.b >= 0 && out.b <= 1) return { ...base, c };
  }
  return { ...base, c: 0 };
}

export function oklchToHex(oklch: OklchColor): HexColor {
  const { r, g, b } = oklchToRgb(fitOklch(oklch));
  return rgbToHex(r, g, b);
}

/** 12-step accent scale (OpenCode's lightness/chroma ramps, per mode). */
export function generateScale(seed: HexColor, isDark: boolean): HexColor[] {
  const base = hexToOklch(seed);
  const scale: HexColor[] = [];
  const lightSteps = isDark
    ? [0.118, 0.138, 0.167, 0.202, 0.246, 0.304, 0.378, 0.468, clamp(base.l * 0.825, 0.53, 0.705), clamp(base.l * 0.89, 0.61, 0.79), clamp(base.l + 0.033, 0.868, 0.943), 0.984]
    : [0.993, 0.983, 0.962, 0.936, 0.906, 0.866, 0.811, 0.74, base.l, Math.max(0, base.l - 0.036), 0.49, 0.27];
  const chromaMultipliers = isDark
    ? [0.52, 0.68, 0.86, 1.02, 1.14, 1.24, 1.36, 1.48, 1.56, 1.64, 1.62, 1.15]
    : [0.12, 0.24, 0.46, 0.68, 0.84, 0.98, 1.08, 1.16, 1.22, 1.26, 1.18, 0.98];
  for (let i = 0; i < 12; i++) {
    scale.push(oklchToHex({ l: lightSteps[i]!, c: base.c * chromaMultipliers[i]!, h: base.h }));
  }
  return scale;
}

/** 12-step neutral ramp; keeps a whisper of the seed's hue (OpenCode's model). */
export function generateNeutralScale(seed: HexColor, isDark: boolean): HexColor[] {
  const base = hexToOklch(seed);
  const neutralChroma = Math.min(base.c, isDark ? 0.068 : 0.04);
  const lightSteps = isDark
    ? [0.138, 0.156, 0.178, 0.202, 0.232, 0.272, 0.326, 0.404, clamp(base.l * 0.83, 0.43, 0.55), 0.596, 0.719, 0.956]
    : [0.991, 0.979, 0.964, 0.946, 0.931, 0.913, 0.891, 0.83, base.l, 0.617, 0.542, 0.205];
  return lightSteps.map((l) => oklchToHex({ l, c: neutralChroma, h: base.h }));
}

export function mixColors(color1: HexColor, color2: HexColor, amount: number): HexColor {
  const c1 = hexToOklch(color1);
  const c2 = hexToOklch(color2);
  const delta = ((((c2.h - c1.h) % 360) + 540) % 360) - 180;
  return oklchToHex({
    l: c1.l + (c2.l - c1.l) * amount,
    c: c1.c + (c2.c - c1.c) * amount,
    h: c1.h + delta * amount,
  });
}

export function shift(color: HexColor, value: { l?: number; c?: number; h?: number }): HexColor {
  const base = hexToOklch(color);
  return oklchToHex({
    l: base.l + (value.l ?? 0),
    c: base.c * (value.c ?? 1),
    h: base.h + (value.h ?? 0),
  });
}

/** WCAG 2.x contrast ratio (same formula as the repo's AA pins). */
export function contrastRatio(foreground: HexColor, background: HexColor): number {
  const linear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = (hex: HexColor): number => {
    const { r, g, b } = hexToRgb(hex);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

export function blend(color: HexColor, background: HexColor, alpha: number): HexColor {
  const fg = hexToRgb(color);
  const bg = hexToRgb(background);
  return rgbToHex(fg.r * alpha + bg.r * (1 - alpha), fg.g * alpha + bg.g * (1 - alpha), fg.b * alpha + bg.b * (1 - alpha));
}

export function withAlpha(color: HexColor, alpha: number): string {
  const { r, g, b } = hexToRgb(color);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}
