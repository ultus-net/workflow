import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

export interface WebappBundle {
  readonly js: string;
  readonly css: string;
}

const entry = resolve(dirname(fileURLToPath(import.meta.url)), "main.tsx");

/**
 * Bundles the React operator surface (React + assistant-ui + styles) into a
 * single IIFE script and stylesheet, held in memory and served by web.ts.
 */
export async function buildWebappBundle(): Promise<WebappBundle> {
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
