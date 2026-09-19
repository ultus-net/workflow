import { useCallback, useEffect, useState } from "react";

import { applyPalette, readStoredPalette, storePalette } from "./theme/palettes.js";

export type ResolvedTheme = "dark" | "light";

const LIGHT_SCHEME = "(prefers-color-scheme: light)";

function resolve(): ResolvedTheme {
  return window.matchMedia(LIGHT_SCHEME).matches ? "light" : "dark";
}

function apply(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "light" ? "#f3f4f6" : "#101216");
}

/**
 * Applies the OS color scheme before first paint (called from main.tsx) so a
 * light-mode operator never sees a dark flash. The palette owns the colors;
 * the OS only picks which palette variant applies.
 */
export function applyStoredTheme(): void {
  apply(resolve());
}

/**
 * Keeps `data-theme` in sync with the OS for the whole session so palettes
 * resolve their dark/light variant. There is no manual mode choice: the
 * palette owns the colors.
 */
export function useTheme(): void {
  useEffect(() => {
    apply(resolve());
    const media = window.matchMedia(LIGHT_SCHEME);
    const onChange = (): void => apply(resolve());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
}

/**
 * Palette control (catalog themes on top of the mode choice). Mounted once at
 * the app root; the settings dialog reads/writes the same choice via props.
 * undefined = Workflow's own amber identity.
 */
export function usePalette(): {
  readonly palette: string | undefined;
  readonly setPalette: (palette: string | undefined) => void;
} {
  const [palette, setPaletteState] = useState<string | undefined>(() => {
    // Validate against the catalog: a stale id must not leave a data-palette
    // attribute with no CSS behind it (that reads as a broken theme).
    return readStoredPalette();
  });

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  const setPalette = useCallback((next: string | undefined): void => {
    storePalette(next);
    setPaletteState(next);
  }, []);

  return { palette, setPalette };
}
