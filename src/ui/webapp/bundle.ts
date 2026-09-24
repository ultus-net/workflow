import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** W127: the PREBUILT seat — scripts/build-webapp-bundle.mjs emits
 * prebuilt.js/prebuilt.css beside the compiled module at BUILD time, so the
 * packaged install (dist only: no src, no devDependencies) serves the
 * operator UI without esbuild and without the source entry. Reading is per
 * call so a rebuild during a long-lived process picks up the fresh
 * artifact; absence falls through to the runtime build (the source seat
 * keeps that path — src/ui/webapp/ never contains a prebuilt copy). */
function readPrebuiltBundle(moduleUrl: string): WebappBundle | undefined {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const jsPath = resolve(moduleDir, "prebuilt.js");
  const cssPath = resolve(moduleDir, "prebuilt.css");
  if (!existsSync(jsPath) || !existsSync(cssPath)) return undefined;
  return { js: readFileSync(jsPath, "utf8"), css: readFileSync(cssPath, "utf8") };
}

/**
 * Bundles the React operator surface (React + assistant-ui + styles) into a
 * single IIFE script and stylesheet, held in memory and served by web.ts.
 */
export async function buildWebappBundle(): Promise<WebappBundle> {
  const prebuilt = readPrebuiltBundle(import.meta.url);
  if (prebuilt !== undefined) return prebuilt;
  // LAZY import (W127): the packaged seat has no esbuild (a devDependency) —
  // a STATIC import here failed the MODULE LOAD itself in a packaged tree
  // (the red the W127 pin first ran as: "Cannot find package 'esbuild'").
  // Only the runtime-build path (source seat, or the compiled fallback with
  // no prebuilt beside it) ever touches this import.
  const { build } = await import("esbuild");
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
