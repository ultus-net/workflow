import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";

/**
 * W042 — the executable assurance-case checker. docs/SECURITY_ASSURANCE.md
 * binds every material security claim to an automated test (exact file and
 * title), a gated live probe, or an explicitly identified manual command.
 * This test parses those citations and fails when any of them ceases to
 * exist, so the assurance map cannot silently drift from the guarantees it
 * claims. Advisory or policy-only behavior is never upgradeable to enforced
 * by documentation — the doc's honesty statements are pinned here too.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assurancePath = join(repoRoot, "docs", "SECURITY_ASSURANCE.md");
const doc = readFileSync(assurancePath, "utf8");

/** test/<file>.test.ts#"<exact title>" — optionally preceded by gated[ENV]: */
const AUTOMATED = /(?:gated\[([A-Z_]+)\]:\s*)?test\/([A-Za-z0-9._/-]+\.test\.ts)#"([^"]+)"/g;
/** manual[npm run <script>] — script names may contain digits (e.g. test:e2e). */
const MANUAL = /manual\[npm run ([a-z0-9:-]+)\]/g;

const require = createRequire(import.meta.url);
const packageScripts: Record<string, string> = require(join(repoRoot, "package.json")).scripts ?? {};

interface Citation {
  readonly file: string;
  readonly title: string;
  readonly gate: string | undefined;
}

function* automatedCitations(): Generator<Citation> {
  for (const match of doc.matchAll(AUTOMATED)) {
    yield { gate: match[1], file: match[2]!, title: match[3]! };
  }
}

test("the assurance case cites its verification comprehensively across all surfaces", () => {
  const citations = [...automatedCitations()];
  // Guard against gutting the map: every surface section must exist, and the
  // citation count must stay substantial.
  for (const section of ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"]) {
    assert.ok(doc.includes(`## ${section} `), `assurance case must keep surface section ${section}`);
  }
  assert.ok(citations.length >= 100, `expected at least 100 automated/gated citations, found ${citations.length}`);
  const gated = citations.filter((citation) => citation.gate !== undefined);
  assert.ok(gated.length >= 8, `expected at least 8 gated probe citations, found ${gated.length}`);
  assert.ok([...doc.matchAll(MANUAL)].length >= 6, "expected at least 6 manual verification citations");
});

test("every claims-table row carries a verification citation (no unverified claims)", () => {
  const dataRows = doc.split("\n").filter((line) => line.startsWith("| ") && !line.includes("| ---") && !line.includes("| Claim |"));
  for (const row of dataRows) {
    const cells = row.split("|").filter((cell) => cell.trim().length > 0);
    if (cells.length !== 3) continue; // catalog/prose tables (S12) have their own columns
    const verification = cells[2] ?? "";
    assert.match(
      verification,
      /test\/[A-Za-z0-9._/-]+\.test\.ts#"|manual\[npm run /,
      `claim row lacks a verification citation: ${cells[0]?.slice(0, 80)}`,
    );
  }
});

test("every cited automated test exists and still contains its cited title", () => {
  const missing: string[] = [];
  for (const citation of automatedCitations()) {
    const path = join(repoRoot, "test", citation.file);
    if (!existsSync(path)) {
      missing.push(`${citation.file} does not exist (title: ${citation.title})`);
      continue;
    }
    const source = readFileSync(path, "utf8");
    if (!source.includes(citation.title)) {
      missing.push(`${citation.file} no longer contains "${citation.title}"`);
    }
    if (citation.gate !== undefined && !source.includes(citation.gate)) {
      missing.push(`${citation.file} does not reference its cited gate ${citation.gate}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every cited manual verification command exists as a package script", () => {
  const missing: string[] = [];
  for (const match of doc.matchAll(MANUAL)) {
    if (packageScripts[match[1]!] === undefined) {
      missing.push(`package.json has no script '${match[1]}'`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the honesty rules stay pinned: advisory is never upgraded, residuals stay stated", () => {
  assert.ok(doc.includes("Advisory is observability, never enforcement"), "honesty rule must stay stated");
  assert.ok(doc.includes("Known residual risks (stated, not hidden)"), "residual-risk section must stay stated");
  // The two headline residuals the threat model calls out explicitly.
  assert.ok(doc.includes("Model-channel exfiltration"), "the C3 exfiltration residual must stay stated");
  assert.ok(doc.includes("G7 compaction is outside hub control over ACP"), "the G7 residual must stay stated");
  assert.ok(doc.includes("discipline honest clients only"), "the same-user honesty limit must stay stated");
  assert.ok(!/\bTODO\b|\bTBD\b/.test(doc), "the assurance case must not carry placeholder claims");
});
