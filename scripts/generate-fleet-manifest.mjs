#!/usr/bin/env node
// Regenerates assets/opencode-fleet/manifest.json from the vendored payload:
// one sha256 per file. The manifest is committed; the doctor compares the
// INSTALLED files against it, and the fleet test re-runs this script's logic
// (fail closed) so the manifest can never silently drift from the assets.
// Run: node scripts/generate-fleet-manifest.mjs
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "assets", "opencode-fleet");
const kinds = [
  { kind: "agent", dir: "agents" },
  { kind: "command", dir: "commands" },
  { kind: "doc", dir: "docs" },
];
const entries = [];
for (const { kind, dir } of kinds) {
  const files = readdirSync(join(root, dir)).filter((file) => file.endsWith(".md")).sort();
  for (const file of files) {
    const sha256 = createHash("sha256").update(readFileSync(join(root, dir, file))).digest("hex");
    entries.push({ id: kind + ":" + file.replace(/\.md$/, ""), kind, file, sha256 });
  }
}
const manifest = { version: 1, entries };
const out = join(root, "manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("manifest: " + out + " (" + entries.length + " entries)");
