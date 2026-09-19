/**
 * Palette application: builds a single <style> element holding every catalog
 * theme's resolved token CSS and mirrors the active choice on
 * <html data-palette>. The Workflow amber identity (styles.css :root) stays
 * the default — a palette only ever overrides it. Presentation-only.
 */
import { paletteToCss, resolveVariant } from "./resolve.js";
import { THEME_DATA } from "./theme-data.js";

const PALETTE_STYLE_ID = "workflow-palettes";
const PALETTE_KEY = "workflow.palette";

export interface PaletteSummary {
  readonly id: string;
  readonly name: string;
  /** Swatch preview from the dark variant (bg, surface, accent fill, text). */
  readonly swatch: { readonly bg: string; readonly surface: string; readonly accent: string; readonly text: string };
}

let styleElement: HTMLStyleElement | undefined;

/** Creates (once) the style element holding every palette's CSS. */
function ensureStyleElement(): HTMLStyleElement {
  if (styleElement !== undefined) return styleElement;
  const existing = document.getElementById(PALETTE_STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    styleElement = existing;
    return styleElement;
  }
  const element = document.createElement("style");
  element.id = PALETTE_STYLE_ID;
  element.textContent = THEME_DATA
    .map((theme) => paletteToCss(theme.id, resolveVariant(theme.dark, true), resolveVariant(theme.light, false)))
    .join("\n");
  document.head.appendChild(element);
  styleElement = element;
  return styleElement;
}

export function readStoredPalette(): string | undefined {
  try {
    const stored = window.localStorage.getItem(PALETTE_KEY);
    return stored !== null && THEME_DATA.some((theme) => theme.id === stored) ? stored : undefined;
  } catch {
    // Storage unavailable: the default amber identity applies.
    return undefined;
  }
}

/**
 * Applies the stored palette before first paint (called from main.tsx next to
 * applyStoredTheme) so a themed operator never sees the amber flash first.
 * CSS arrives via the injected style tag; only the attribute matters here.
 */
export function applyStoredPalette(): void {
  const palette = readStoredPalette();
  if (palette === undefined) return;
  document.documentElement.dataset.palette = palette;
  ensureStyleElement();
}

/** Sets the active palette (undefined = Workflow's own amber identity). */
export function applyPalette(palette: string | undefined): void {
  if (palette === undefined) {
    delete document.documentElement.dataset.palette;
    return;
  }
  document.documentElement.dataset.palette = palette;
  ensureStyleElement();
}

export function storePalette(palette: string | undefined): void {
  try {
    if (palette === undefined) window.localStorage.removeItem(PALETTE_KEY);
    else window.localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Storage unavailable: the choice applies for this session only.
  }
}

/** The catalog for the settings picker: id, display name, swatch preview. */
export function listPalettes(): readonly PaletteSummary[] {
  return THEME_DATA.map((theme) => {
    const tokens = resolveVariant(theme.dark, true);
    return {
      id: theme.id,
      name: theme.name,
      swatch: { bg: tokens.bg, surface: tokens.surface, accent: tokens.accentFill, text: tokens.text },
    };
  });
}
