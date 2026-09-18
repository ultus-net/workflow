/**
 * The vendored OpenCode desktop themes (github.com/sst/opencode, MIT), wired
 * as a registry. Data only — resolveVariant maps each theme to Workflow's
 * token set at runtime (see resolve.ts). Ids and display names come from the
 * theme files themselves.
 */
import type { ThemeVariant } from "./resolve.js";

import amoled from "../themes/amoled.json" with { type: "json" };
import aura from "../themes/aura.json" with { type: "json" };
import ayu from "../themes/ayu.json" with { type: "json" };
import carbonfox from "../themes/carbonfox.json" with { type: "json" };
import catppuccin from "../themes/catppuccin.json" with { type: "json" };
import catppuccin_frappe from "../themes/catppuccin-frappe.json" with { type: "json" };
import catppuccin_macchiato from "../themes/catppuccin-macchiato.json" with { type: "json" };
import cobalt2 from "../themes/cobalt2.json" with { type: "json" };
import cursor from "../themes/cursor.json" with { type: "json" };
import dracula from "../themes/dracula.json" with { type: "json" };
import everforest from "../themes/everforest.json" with { type: "json" };
import flexoki from "../themes/flexoki.json" with { type: "json" };
import github from "../themes/github.json" with { type: "json" };
import gruvbox from "../themes/gruvbox.json" with { type: "json" };
import kanagawa from "../themes/kanagawa.json" with { type: "json" };
import lucent_orng from "../themes/lucent-orng.json" with { type: "json" };
import material from "../themes/material.json" with { type: "json" };
import matrix from "../themes/matrix.json" with { type: "json" };
import mercury from "../themes/mercury.json" with { type: "json" };
import monokai from "../themes/monokai.json" with { type: "json" };
import nightowl from "../themes/nightowl.json" with { type: "json" };
import nord from "../themes/nord.json" with { type: "json" };
import oc_2 from "../themes/oc-2.json" with { type: "json" };
import one_dark from "../themes/one-dark.json" with { type: "json" };
import onedarkpro from "../themes/onedarkpro.json" with { type: "json" };
import opencode from "../themes/opencode.json" with { type: "json" };
import orng from "../themes/orng.json" with { type: "json" };
import osaka_jade from "../themes/osaka-jade.json" with { type: "json" };
import palenight from "../themes/palenight.json" with { type: "json" };
import rosepine from "../themes/rosepine.json" with { type: "json" };
import shadesofpurple from "../themes/shadesofpurple.json" with { type: "json" };
import solarized from "../themes/solarized.json" with { type: "json" };
import synthwave84 from "../themes/synthwave84.json" with { type: "json" };
import tokyonight from "../themes/tokyonight.json" with { type: "json" };
import vercel from "../themes/vercel.json" with { type: "json" };
import vesper from "../themes/vesper.json" with { type: "json" };
import zenburn from "../themes/zenburn.json" with { type: "json" };

export interface ThemeEntry {
  /** Theme slug from the JSON (pattern `^[a-z0-9-]+$`). */
  readonly id: string;
  readonly name: string;
  readonly dark: ThemeVariant;
  readonly light: ThemeVariant;
}

type RawTheme = { name?: string; id?: string; dark?: unknown; light?: unknown };

const entry = (theme: RawTheme): ThemeEntry => ({
  id: typeof theme.id === "string" ? theme.id : "unknown",
  name: typeof theme.name === "string" ? theme.name : "Unknown",
  dark: theme.dark as ThemeVariant,
  light: theme.light as ThemeVariant,
});

export const THEME_DATA: readonly ThemeEntry[] = [
  amoled, aura, ayu, carbonfox, catppuccin, catppuccin_frappe, catppuccin_macchiato,
  cobalt2, cursor, dracula, everforest, flexoki, github, gruvbox, kanagawa,
  lucent_orng, material, matrix, mercury, monokai, nightowl, nord, oc_2, one_dark,
  onedarkpro, opencode, orng, osaka_jade, palenight, rosepine, shadesofpurple,
  solarized, synthwave84, tokyonight, vercel, vesper, zenburn,
].map(entry);
