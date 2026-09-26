// ledger-extract.mjs — split TASKS.md W-items into docs/ledger/W###-slug.md.
//
// Migration (2026-09-26, operator direction): live task tracking moves to the
// GitHub Project; the in-repo ledger becomes one write-once file per work item
// (append-only landed records, no shared-file tail, no W-number collisions).
// This pass is NON-DESTRUCTIVE: TASKS.md stays the canonical file until the
// reduction pass replaces extracted entries with pointer lines.
//
// Splitting rule: every top-level "### W\d+ - " heading opens a fragment; the
// fragment is the heading plus all content until the next heading (or EOF).
// Phase/Checkpoint preambles stay in TASKS.md. Extraction is byte-preserving:
// each fragment's body must equal its source slice exactly, or the script
// fails with a report (parity IS the verification).
//
// Usage:
//   node scripts/ledger-extract.mjs                  write docs/ledger/*.md
//   node scripts/ledger-extract.mjs --check          verify parity, write nothing
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

const root = process.cwd();
const source = join(root, "TASKS.md");
const outDir = join(root, "docs", "ledger");
const headingRe = /^### W(\d+[ab]?) - (.+)$/;

const lines = readFileSync(source, "utf8").split("\n");

const starts = [];
lines.forEach((line, i) => {
  if (headingRe.test(line)) starts.push(i);
});

const slices = starts.map((start, idx) => {
  const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
  return { start, end, raw: lines.slice(start, end) };
});

const provenance = (line1) =>
  `<!-- Ledger fragment: extracted from ${basename(source)} at line ${line1} of ` +
  `the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in ` +
  `the GitHub Project; this file is a write-once landed record — append ` +
  `dated supersession notes, never rewrite. -->\n\n`;

const slugify = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";

const parityFailures = [];
const indexLines = [];
let written = 0;

if (!checkOnly) mkdirSync(outDir, { recursive: true });

for (const { start, end, raw } of slices) {
  const m = headingRe.exec(raw[0]);
  const num = m[1];
  const fileName = `W${num}-${slugify(m[2])}.md`;
  const body = raw.join("\n");
  const line1 = `${start + 1}`;

  if (checkOnly) {
    let onDisk = "";
    try {
      onDisk = readFileSync(join(outDir, fileName), "utf8");
    } catch {
      parityFailures.push(`${fileName}: MISSING`);
      continue;
    }
    const stripped = onDisk.replace(/^<!--[\s\S]*?-->\n\n/, "");
    if (stripped !== body) {
      parityFailures.push(`${fileName}: CONTENT MISMATCH (${stripped.length} vs ${body.length} bytes)`);
    } else {
      indexLines.push(`${num} ${fileName}`);
    }
    continue;
  }

  writeFileSync(join(outDir, fileName), provenance(line1) + body);
  indexLines.push(`${num} ${fileName}`);
  written += 1;
}

if (checkOnly) {
  if (parityFailures.length > 0) {
    console.error(`parity failures (${parityFailures.length}):`);
    for (const f of parityFailures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`parity ok: ${indexLines.length} fragments match TASKS.md`);
  process.exit(0);
}

console.log(`extracted ${written} fragments into docs/ledger/`);
