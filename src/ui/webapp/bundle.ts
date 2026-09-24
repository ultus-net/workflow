import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

export interface WebappBundle {
  readonly js: string;
  readonly css: string;
}

/** W124 (the compiled-launcher web surface): the esbuild entry is
 * LAYOUT-AWARE — a source-layout module (tsx runs bundle.ts beside
 * main.tsx) resolves the sibling; a compiled-layout module (dist/ui/
 * webapp/bundle.js — tsc emits main.js, never a .tsx) bundles the src copy
 * three directories up. The src-vs-dist skew here broke the compiled
 * launcher's web surface while source mode worked — the LESS-0012
 * dual-surface parity rule applied to the bundle seam. */
export function resolveWebappEntry(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const sibling = resolve(moduleDir, "main.tsx");
  if (existsSync(sibling)) return sibling;
  const sourceEntry = resolve(moduleDir, "..", "..", "..", "src", "ui", "webapp", "main.tsx");
  if (existsSync(sourceEntry)) return sourceEntry;
  throw new Error(
    `webapp entry main.tsx not found (looked in ${sibling} and ${sourceEntry}) — the webapp bundle requires the source entry beside the module or at src/ui/webapp/main.tsx`,
  );
}

/**
 * Bundles the React operator surface (React + assistant-ui + styles) into a
 * single IIFE script and stylesheet, held in memory and served by web.ts.
 */
export async function buildWebappBundle(): Promise<WebappBundle> {
  const entry = resolveWebappEntry(import.meta.url);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    outdir: "webapp-out",
    format: "iife",
    jsx: "automatic",
    minify: true,
    target: "es2022",
    logLevel: "silent",
  });
  const js = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
  if (js === undefined || css === undefined) throw new Error("webapp bundle did not produce js and css outputs");
  return { js, css };
}
