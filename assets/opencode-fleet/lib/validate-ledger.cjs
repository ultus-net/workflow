#!/usr/bin/env node
/**
 * validate-ledger.cjs
 *
 * A read-only admission gate for the RSI experiment ledger (docs/agents/ledger.md).
 * Schema v2 (winner's curse, 2610.09239) requires every NEW record to report a
 * `selection score` (the items the loop selected against) and a `held-out score`
 * (a disjoint item set never used for selection), plus a hash-chain link to the
 * prior record (`hash-chained admission`, 2610.10629). This gate is the
 * mechanical half of that: it enforces the *shape* — the two item-counted score
 * lines, the disjointness declaration, and a `prev-chain: sha256:<hex>` that
 * actually equals the sha256 of the preceding record block. The semantic half —
 * "is the held-out set truly disjoint, and does the claimed score match the run?"
 * — is an external review, not a regex, and stays reviewer-owned.
 *
 * Scope: only records with `n` greater than the maximum `n` already committed at
 * `HEAD` are checked. Earlier records are grandfathered, so the v1 history that
 * predates this schema is never rewritten or rejected.
 *
 * It never writes. Exit codes: 0 = clean, 1 = violations, 2 = usage/internal error.
 *
 * Usage:
 *   node install/lib/validate-ledger.cjs [--ledger FILE]
 */

'use strict';

// Reads the staged content under OPENCODE_VALIDATE_INDEX=1 (pre-commit), so the
// admission gate validates the commit, not the working tree.
const fs   = require('./index-read.cjs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

/**
 * The git work tree the gate operates on, resolved from the cwd (or
 * `OPENCODE_VALIDATE_ROOT` in tests) rather than this module's own path. The
 * live entry is a symlink (`~/.config/opencode/lib/validate-ledger.cjs`), so
 * `__dirname` resolves back to the dotfiles repo; rooting on `__dirname` would
 * validate the wrong ledger when the gate runs in a target repo. Mirrors the
 * `gitRoot()` contract in `index-read.cjs`. Not cached, so a test can repoint
 * it per case.
 */
function repoRoot() {
  const start = process.env.OPENCODE_VALIDATE_ROOT || process.cwd();
  try {
    return execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(__dirname, '..', '..');
  }
}

// A record header is a top-level `### n=<k>` line (the campaign `#### n=<k>`
// sub-records are header depth 4 and are deliberately not top-level records).
const HEADER_RE     = /^### n=(\d+)\b/;
// A `(N items)` item count, optionally followed by `, ...` (e.g. the held-out
// line's "never used for selection" clause).
const ITEM_COUNT_RE = /\(\s*(\d+)\s+items?\s*[,)]/i;
// The held-out items must be declared never used for selection.
const DISJOINT_RE   = /never used for selection/i;
// The chain link, with the sha256: prefix the schema mandates.
const PREV_CHAIN_RE = /prev-chain:\s*sha256:([0-9a-fA-F]+)/i;

/** sha256 hex of a raw block's exact bytes (utf8). Pure. */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Split ledger text into record blocks in file order. Each block is the byte
 * range from the start of its `### n=<k>` header line to the start of the next
 * record header (exclusive) — i.e. the exact bytes a `prev-chain` link hashes.
 * Pure: takes text, returns `[{ n, header, start, end, raw }]`.
 */
function parseRecords(text) {
  const records = [];
  let offset = 0;
  let current = null;
  for (const line of text.split('\n')) {
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current) {
        current.end = offset;
        current.raw = text.slice(current.start, offset);
        records.push(current);
      }
      current = { n: Number(m[1]), header: line, start: offset };
    }
    offset += line.length + 1; // account for the '\n' split() dropped
  }
  if (current) {
    current.end = text.length;
    current.raw = text.slice(current.start);
    records.push(current);
  }
  return records;
}

/** The maximum record `n` in the text, or null when there are no records. Pure. */
function maxRecordN(text) {
  const records = parseRecords(text);
  return records.length ? Math.max(...records.map((r) => r.n)) : null;
}

/** The first line (case-insensitive) that carries a field label, or null. */
function findLine(lines, label) {
  const needle = label.toLowerCase();
  for (const line of lines) if (line.toLowerCase().includes(needle)) return line;
  return null;
}

/**
 * The score value on a held-out line, up to the `(N items)` clause. Empty when
 * the line carries only an item count and no score — the "keep with an empty
 * held-out score" failure this gate exists to catch.
 */
function heldScoreText(line) {
  const i = line.toLowerCase().indexOf('held-out score');
  let v = line.slice(i + 'held-out score'.length);
  v = v.replace(/^[\s:*`_]+/, '');
  const paren = v.indexOf('(');
  if (paren !== -1) v = v.slice(0, paren);
  return v.replace(/[*`_]/g, '').trim();
}

/** The keep/revert verdict tail (lowercased, markdown stripped), or null. Pure. */
function keepVerdict(raw) {
  for (const line of raw.split('\n')) {
    const i = line.toLowerCase().indexOf('keep/revert');
    if (i === -1) continue;
    return line.slice(i + 'keep/revert'.length).replace(/[*`_:\s]+/g, ' ').trim().toLowerCase();
  }
  return null;
}

/**
 * Check one new record against the v2 schema. Pure: takes the record and its
 * preceding record (for the chain), returns an array of error strings that each
 * name the record and the field.
 */
function checkRecord(record, prevRecord) {
  const errors = [];
  const label = `n=${record.n}`;
  const raw = record.raw;
  const lines = raw.split('\n');

  // selection score (item-counted)
  const selLine = findLine(lines, 'selection score');
  if (!selLine) errors.push(`${label}: missing "selection score" line with an item count`);
  else if (!ITEM_COUNT_RE.test(selLine)) errors.push(`${label}: "selection score" has no "(N items)" item count`);

  // held-out score (item-counted)
  const heldLine = findLine(lines, 'held-out score');
  const heldCounted = heldLine !== null && ITEM_COUNT_RE.test(heldLine);
  if (!heldLine) errors.push(`${label}: missing "held-out score" line with an item count`);
  else if (!heldCounted) errors.push(`${label}: "held-out score" has no "(N items)" item count`);

  // disjointness declaration
  if (!DISJOINT_RE.test(raw)) errors.push(`${label}: missing disjointness declaration ("never used for selection")`);

  // prev-chain link
  const chain = PREV_CHAIN_RE.exec(raw);
  if (!chain) {
    errors.push(`${label}: missing "prev-chain: sha256:<hex>" field`);
  } else if (chain[1].length !== 64) {
    errors.push(`${label}: prev-chain hex is ${chain[1].length} chars, expected 64`);
  } else if (!prevRecord) {
    errors.push(`${label}: no preceding record to chain (prev-chain cannot be verified)`);
  } else {
    const want = sha256(prevRecord.raw);
    if (chain[1].toLowerCase() !== want) errors.push(`${label}: prev-chain mismatch (expected sha256:${want})`);
  }

  // keep verdict requires a non-empty held-out score
  const verdict = keepVerdict(raw);
  if (verdict !== null && /^keep\b/.test(verdict)) {
    if (!heldLine) errors.push(`${label}: "keep" requires a non-empty held-out score (no held-out score line)`);
    else if (!heldCounted || heldScoreText(heldLine) === '') errors.push(`${label}: "keep" requires a non-empty held-out score`);
  }

  return errors;
}

/**
 * Validate the ledger text against the schema for records newer than `headMax`.
 * `headMax` is the committed maximum `n` (null = no committed baseline, so every
 * record is new). Returns `{ records, newRecords, errors, maxN }`.
 */
function validateLedger(text, headMax) {
  const records = parseRecords(text);
  const baseline = headMax == null ? null : headMax;
  const newRecords = [];
  const errors = [];
  records.forEach((record, i) => {
    if (baseline !== null && record.n <= baseline) return; // grandfathered
    newRecords.push(record);
    errors.push(...checkRecord(record, records[i - 1] || null));
  });
  return { records, newRecords, errors, maxN: baseline };
}

/** The committed ledger at HEAD, or null when git/HEAD is unavailable. */
function headLedgerText() {
  try {
    return execFileSync('git', ['-C', repoRoot(), 'show', 'HEAD:docs/agents/ledger.md'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { ledger: path.join(repoRoot(), 'docs/agents/ledger.md') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ledger') { const v = argv[++i]; if (v == null) return { error: '--ledger requires a file' }; opts.ledger = path.resolve(v); }
    else if (a === '-h' || a === '--help') opts.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: validate-ledger.cjs [--ledger FILE]');
    return 0;
  }

  let text;
  try {
    text = fs.readFileSync(opts.ledger, 'utf8');
  } catch {
    console.error(`  \u2717  ledger not readable: ${opts.ledger}`);
    return 1;
  }

  let result;
  try {
    const headText = headLedgerText();
    const headMax = headText == null ? null : maxRecordN(headText);
    result = validateLedger(text, headMax);
  } catch (e) {
    console.error(`  \u2717  internal error: ${e.message}`);
    return 2;
  }

  if (result.errors.length === 0) {
    console.log(`  \u2713  ledger holdout schema \u2014 ${result.newRecords.length} new record(s), ${result.records.length} total, 0 error(s)`);
    return 0;
  }
  console.log(`  \u2717  ledger holdout schema \u2014 ${result.errors.length} error(s):`);
  for (const e of result.errors) console.log(`      - ${e}`);
  return 1;
}

module.exports = {
  HEADER_RE, ITEM_COUNT_RE, DISJOINT_RE, PREV_CHAIN_RE,
  sha256, parseRecords, maxRecordN, heldScoreText, keepVerdict,
  checkRecord, validateLedger, repoRoot, parseArgs, main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
