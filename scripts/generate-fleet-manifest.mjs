#!/usr/bin/env node
// Regenerates assets/opencode-fleet/manifest.json from the vendored payload:
// one sha256 per file, walked recursively over every kind directory. The
// manifest is committed; the doctor compares the INSTALLED files against it,
// and the fleet test re-runs this script's logic (fail closed) so the manifest
// can never silently drift from the assets.
//
// Kinds and their vendored source directories:
//   agent       agents/        (flat *.md)
//   command     commands/      (flat *.md)
//   doc         docs/          (flat *.md; portable guides only, no subdirs)
//   instruction instructions/  (flat *.md; global AGENTS.md + STANDARDS.md)
//   style       style/         (flat *.md)
//   template    templates/     (recursive .md; templates/rsi/*.md)
//   skill       skills/        (recursive .md/.txt/.json; skills/<name>/*)
//   lib         lib/           (recursive .cjs/.sh/.ts + LICENSE; the harness rulers)
//   host-config host-config/   (flat .json/.jsonc; reference-only, never installed)
//
// Every matching file (not only *.md) is hashed for the recursive kinds, so a
// skill or template that ships a non-markdown asset still rides the manifest.
// Run: node scripts/generate-fleet-manifest.mjs
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "assets", "opencode-fleet");
const kinds = [
  { kind: "agent", dir: "agents", recursive: false, ext: ["md"] },
  { kind: "command", dir: "commands", recursive: false, ext: ["md"] },
  { kind: "doc", dir: "docs", recursive: false, ext: ["md"] },
  { kind: "instruction", dir: "instructions", recursive: false, ext: ["md"] },
  { kind: "style", dir: "style", recursive: false, ext: ["md"] },
  { kind: "template", dir: "templates", recursive: true, ext: ["md"] },
  { kind: "skill", dir: "skills", recursive: true, ext: ["md", "txt", "json"] },
  { kind: "lib", dir: "lib", recursive: true, ext: ["cjs", "sh", "ts", ""] },
  { kind: "host-config", dir: "host-config", recursive: false, ext: ["json", "jsonc"] },
];

/** Every matching file under `dir`, as absolute paths. */
function walk(dir, ext, recursive) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (recursive) found.push(...walk(join(dir, entry.name), ext, recursive));
      continue;
    }
    const suffix = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".") + 1) : "";
    if (ext.includes(suffix)) found.push(join(dir, entry.name));
  }
  return found;
}

const entries = [];
for (const { kind, dir, recursive, ext } of kinds) {
  const base = join(root, dir);
  const files = walk(base, ext, recursive).sort();
  for (const file of files) {
    const fileRel = relative(base, file).split("\\").join("/");
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    entries.push({ id: kind + ":" + fileRel, kind, file: fileRel, sha256 });
  }
}
const manifest = { version: 1, entries };
const out = join(root, "manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("manifest: " + out + " (" + entries.length + " entries)");
