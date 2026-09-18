/**
 * Resolves an OpenCode desktop-theme JSON variant (the `palette` seed set or
 * the legacy `seeds` form) into Workflow's web token set. Scale machinery is
 * ported from OpenCode's MIT theme engine; the token mapping and the AA
 * correction are Workflow's own (DESIGN.md: status and accent text must pass
 * WCAG AA on their surfaces, so a theme that cannot is nudged toward its own
 * text color — hue identity survives, contrast is guaranteed).
 */
import type { HexColor } from "./color.js";
import {
  contrastRatio,
  generateNeutralScale,
  generateScale,
  hexToOklch,
  mixColors,
  shift,
  withAlpha,
} from "./color.js";

export interface ThemeSeeds {
  readonly neutral: HexColor;
  readonly ink?: HexColor;
  readonly primary: HexColor;
  readonly accent?: HexColor;
  readonly success: HexColor;
  readonly warning: HexColor;
  readonly error: HexColor;
  readonly info: HexColor;
  readonly diffAdd?: HexColor;
  readonly diffDelete?: HexColor;
}

export interface ThemeVariant {
  readonly palette?: ThemeSeeds;
  readonly seeds?: Omit<ThemeSeeds, "ink">;
  readonly overrides?: Record<string, string>;
}

export interface PaletteTokens {
  readonly bg: HexColor;
  readonly bgDeep: HexColor;
  readonly surface: HexColor;
  readonly surfaceRaised: HexColor;
  readonly border: HexColor;
  readonly borderStrong: HexColor;
  readonly text: HexColor;
  readonly textMuted: HexColor;
  /** Text/outline-safe accent (Workflow's --accent discipline). */
  readonly accent: HexColor;
  /** Fill-safe accent for buttons, bubbles, toggles. */
  readonly accentFill: HexColor;
  readonly accentInk: HexColor;
  readonly accentSoft: string;
  readonly ok: HexColor;
  readonly deny: HexColor;
  readonly fail: HexColor;
  readonly composerFocus: HexColor;
  readonly codeBg: HexColor;
  readonly hljs: {
    readonly comment: HexColor;
    readonly keyword: HexColor;
    readonly string: HexColor;
    readonly number: HexColor;
    readonly title: HexColor;
    readonly addition: HexColor;
    readonly deletion: HexColor;
  };
}

/** WCAG AA for normal text. */
const AA = 4.5;

/** Nudges `color` toward `text` (same hue family, via OKLab mix) until the
 * pair passes AA against `bg`. Deterministic; converges because text is
 * chosen to contrast with bg. */
function ensureAA(color: HexColor, text: HexColor, bg: HexColor, target: number = AA): HexColor {
  if (contrastRatio(color, bg) >= target) return color;
  for (let amount = 0.1; amount <= 1; amount += 0.1) {
    const mixed = mixColors(color, text, amount);
    if (contrastRatio(mixed, bg) >= target) return mixed;
  }
  return text;
}

/** Text-safe tone of a seed: OpenCode's `content()` discipline — a scale tone
 * far enough from the background to read as text. */
function contentTone(seed: HexColor, isDark: boolean): HexColor {
  const base = hexToOklch(seed);
  const scale = generateScale(seed, isDark);
  const value = isDark
    ? (base.l > 0.84 ? shift(seed, { c: 1.18 }) : scale[10]!)
    : scale[10]!;
  return shift(value, { l: isDark ? 0.034 : -0.024, c: isDark ? 1.3 : 1.18 });
}

export function resolveVariant(variant: ThemeVariant, isDark: boolean): PaletteTokens {
  const seeds: ThemeSeeds = variant.palette !== undefined
    ? variant.palette
    : variant.seeds !== undefined
      ? { ...variant.seeds }
      : (() => { throw new Error("theme variant requires `palette` or `seeds`"); })();

  const neutral = generateNeutralScale(seeds.neutral, isDark);
  const ink = seeds.ink ?? (isDark ? neutral[10]! : neutral[11]!);
  const bg = neutral[0]!;
  const bgDeep = isDark ? shift(bg, { l: -0.014, c: 0.9 }) : neutral[2]!;
  const surface = neutral[1]!;
  const surfaceRaised = neutral[2]!;
  const border = neutral[isDark ? 3 : 7]!;
  const borderStrong = neutral[isDark ? 5 : 8]!;
  const text = ensureAA(ink, isDark ? "#ffffff" : "#0b0d10", bg);
  const textMuted = ensureAA(mixColors(text, bg, 0.62), text, bg);

  const primaryScale = generateScale(seeds.primary, isDark);
  const accentFill = primaryScale[8]!;
  const accentInk = contrastRatio("#ffffff", accentFill) >= contrastRatio("#000000", accentFill) ? "#ffffff" as HexColor : "#000000" as HexColor;
  const accent = ensureAA(contentTone(seeds.primary, isDark), text, bg);
  const accentSoft = withAlpha(accentFill, 0.16);

  const ok = ensureAA(contentTone(seeds.success, isDark), text, bg);
  const fail = ensureAA(contentTone(seeds.error, isDark), text, bg);
  const deny = ensureAA(contentTone(seeds.diffDelete ?? seeds.error, isDark), text, bg);
  const diffAdd = generateScale(seeds.diffAdd ?? shift(seeds.success, { c: isDark ? 0.7 : 0.55, l: isDark ? -0.18 : 0.14 }), isDark);
  const diffDelete = generateScale(seeds.diffDelete ?? shift(seeds.error, { c: isDark ? 0.82 : 0.7, l: isDark ? -0.08 : 0.08 }), isDark);

  // Composer focus tint: one neutral step off the panel, never a saturated
  // accent wash — a loud input reads as a validation state, not focus.
  const composerFocus = isDark ? neutral[1]! : "#ffffff" as HexColor;
  const codeBg = isDark ? shift(bg, { l: -0.012, c: 0.92 }) : neutral[1]!;

  // Syntax roles from the theme's own hues (comment stays quiet; the rest are
  // text-safe tones so code never depends on a hard-coded hljs theme).
  const hljs = {
    comment: ensureAA(mixColors(text, bg, 0.5), text, bg),
    keyword: ensureAA(contentTone(seeds.accent ?? seeds.primary, isDark), text, bg),
    string: ensureAA(contentTone(seeds.success, isDark), text, bg),
    number: ensureAA(contentTone(seeds.warning, isDark), text, bg),
    title: ensureAA(contentTone(seeds.info, isDark), text, bg),
    addition: ensureAA(diffAdd[isDark ? 10 : 8]!, text, bg),
    deletion: ensureAA(diffDelete[isDark ? 10 : 8]!, text, bg),
  };

  return {
    bg, bgDeep, surface, surfaceRaised, border, borderStrong, text, textMuted,
    accent, accentFill, accentInk, accentSoft, ok, deny, fail, composerFocus, codeBg, hljs,
  };
}

/** Emits the CSS custom-property block for one palette variant, using
 * Workflow's existing token names so every component keeps working. */
export function variantToCss(tokens: PaletteTokens): string {
  return [
    `--bg: ${tokens.bg};`,
    `--bg-deep: ${tokens.bgDeep};`,
    `--surface: ${tokens.surface};`,
    `--surface-raised: ${tokens.surfaceRaised};`,
    `--border: ${tokens.border};`,
    `--border-strong: ${tokens.borderStrong};`,
    `--text: ${tokens.text};`,
    `--text-muted: ${tokens.textMuted};`,
    `--accent: ${tokens.accent};`,
    `--accent-fill: ${tokens.accentFill};`,
    `--accent-ink: ${tokens.accentInk};`,
    `--accent-soft: ${tokens.accentSoft};`,
    `--ok: ${tokens.ok};`,
    `--deny: ${tokens.deny};`,
    `--fail: ${tokens.fail};`,
    `--composer-focus: ${tokens.composerFocus};`,
    `--code-bg: ${tokens.codeBg};`,
  ].join("\n    ");
}

const HLJS_ROLES: ReadonlyArray<readonly [string, keyof PaletteTokens["hljs"]]> = [
  [".hljs-comment, .hljs-quote", "comment"],
  [".hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-doctag, .hljs-type, .hljs-name, .hljs-strong", "keyword"],
  [".hljs-string, .hljs-regexp, .hljs-attribute, .hljs-meta .hljs-string", "string"],
  [".hljs-number, .hljs-symbol, .hljs-bullet, .hljs-variable, .hljs-template-variable, .hljs-selector-attr", "number"],
  [".hljs-title, .hljs-title.function_, .hljs-built_in, .hljs-class .hljs-title", "title"],
  [".hljs-addition", "addition"],
  [".hljs-deletion", "deletion"],
];

/** CSS rules for one palette covering both Workflow modes. */
export function paletteToCss(paletteId: string, dark: PaletteTokens, light: PaletteTokens): string {
  const scope = (mode: string, tokens: PaletteTokens): string =>
    `html[data-palette="${paletteId}"][data-theme="${mode}"] {\n    ${variantToCss(tokens)}\n  }`;
  const hljs = (mode: string, tokens: PaletteTokens): string =>
    HLJS_ROLES
      .map(([roles, key]) => `html[data-palette="${paletteId}"][data-theme="${mode}"] ${roles} { color: ${tokens.hljs[key]}; }`)
      .join("\n  ");
  return [
    scope("dark", dark),
    hljs("dark", dark),
    scope("light", light),
    hljs("light", light),
    `html[data-palette="${paletteId}"] { color-scheme: dark; }\n  html[data-palette="${paletteId}"][data-theme="light"] { color-scheme: light; }`,
  ].join("\n  ");
}
