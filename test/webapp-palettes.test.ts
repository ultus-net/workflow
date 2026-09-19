import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { contrastRatio, type HexColor } from "../src/ui/webapp/theme/color.js";
import { paletteToCss, resolveVariant } from "../src/ui/webapp/theme/resolve.js";
import { THEME_DATA } from "../src/ui/webapp/theme/theme-data.js";

// Palette-engine gate. Every vendored theme must resolve for both modes and
// every resolved surface pair must pass WCAG AA the same way the built-in
// Workflow tokens do (DESIGN.md discipline). A theme that fails here fails
// the build — the operator's contrast bar does not bend for fashion.

test("every vendored theme carries an id, a name, and both variants", () => {
  assert.ok(THEME_DATA.length >= 30, `expected the full catalog, found ${THEME_DATA.length}`);
  for (const theme of THEME_DATA) {
    assert.match(theme.id, /^[a-z0-9-]+$/, `theme id "${theme.id}" must be a slug`);
    assert.ok(theme.name.length > 0, `theme ${theme.id} must have a display name`);
    assert.ok(theme.dark !== undefined && theme.light !== undefined, `theme ${theme.id} must have dark and light variants`);
  }
});

test("every theme resolves to a complete Workflow token set in both modes", () => {
  for (const theme of THEME_DATA) {
    for (const [mode, variant] of [["dark", theme.dark], ["light", theme.light]] as const) {
      const tokens = resolveVariant(variant, mode === "dark");
      for (const key of ["bg", "bgDeep", "surface", "surfaceRaised", "border", "borderStrong", "text", "textMuted", "accent", "accentFill", "accentInk", "ok", "deny", "fail", "composerFocus", "codeBg"] as const) {
        assert.ok(typeof tokens[key] === "string" && (tokens[key] as string).startsWith("#"), `${theme.id}/${mode}: token ${key} must be a hex color`);
      }
    }
  }
});

test("every theme passes WCAG AA text pairs in both modes (operator contrast bar)", () => {
  for (const theme of THEME_DATA) {
    for (const [mode, variant] of [["dark", theme.dark], ["light", theme.light]] as const) {
      const t = resolveVariant(variant, mode === "dark");
      const label = `${theme.id}/${mode}`;
      assert.ok(contrastRatio(t.text as HexColor, t.bg as HexColor) >= 4.5, `${label}: text on bg below AA`);
      assert.ok(contrastRatio(t.textMuted as HexColor, t.bg as HexColor) >= 4.5, `${label}: muted text on bg below AA`);
      assert.ok(contrastRatio(t.accent as HexColor, t.bg as HexColor) >= 4.5, `${label}: accent text on bg below AA`);
      assert.ok(contrastRatio(t.ok as HexColor, t.bg as HexColor) >= 4.5, `${label}: ok on bg below AA`);
      assert.ok(contrastRatio(t.deny as HexColor, t.bg as HexColor) >= 4.5, `${label}: deny on bg below AA`);
      assert.ok(contrastRatio(t.fail as HexColor, t.bg as HexColor) >= 4.5, `${label}: fail on bg below AA`);
      assert.ok(contrastRatio(t.accentInk as HexColor, t.accentFill as HexColor) >= 4.5, `${label}: ink on accent fill below AA`);
    }
  }
});

test("palette CSS stays square and scopes to the data-palette attribute", () => {
  const theme = THEME_DATA[0]!;
  const css = paletteToCss(theme.id, resolveVariant(theme.dark, true), resolveVariant(theme.light, false));
  assert.match(css, new RegExp(`html\\[data-palette="${theme.id}"\\]`), "palette CSS must scope to its attribute");
  const declarations = [...css.matchAll(/border-radius:\s*([^;]+);/g)];
  assert.deepEqual(declarations.map((match) => match[1]), [], "palette CSS must not introduce border-radius");
});

test("the vendored theme JSONs stay byte-identical to their ids", () => {
  // Cheap drift guard: the registry ids must match the JSON files on disk.
  for (const theme of THEME_DATA) {
    const file = resolve("src/ui/webapp/themes", `${theme.id}.json`);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: string };
    assert.equal(parsed.id, theme.id, `registry id ${theme.id} must match the JSON file it came from`);
  }
});
