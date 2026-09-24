// W127: emit the PREBUILT webapp bundle beside the compiled module at build
// time, so the packaged seat (dist only: no src, no devDependencies) serves
// the operator UI without esbuild and without the source entry. The options
// MIRROR src/ui/webapp/bundle.ts's runtime build — the two seats must bundle
// identically (the css side-effect import resolves from the same entry);
// keep the two option sets in sync.
import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

await build({
  entryPoints: [resolve(repoRoot, "src", "ui", "webapp", "main.tsx")],
  outdir: resolve(repoRoot, "dist", "ui", "webapp"),
  entryNames: "prebuilt",
  bundle: true,
  write: true,
  format: "iife",
  jsx: "automatic",
  minify: true,
  target: "es2022",
  logLevel: "silent",
});