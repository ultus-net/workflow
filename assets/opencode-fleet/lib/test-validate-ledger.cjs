#!/usr/bin/env node
/**
 * test-validate-ledger.cjs — fixtures for validate-ledger.cjs
 *
 * The gate is only as good as its teeth, so each check is exercised on both a
 * passing and a failing input: a fixture that asserts a pass must pair with one
 * that asserts the same check fails its boundary (the n=11 lesson: a verifier
 * that passes everything proves nothing). The fixtures pass synthetic ledger
 * text to the validator's exported parse/validate functions.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const v = require('./validate-ledger.cjs');

// A v1-shaped (grandfathered) record: no v2 fields.
const V1_BLOCK = '### n=10 — an older record\n\n- score: pass.\n- keep/revert: keep.\n';

/** A v2 record whose prev-chain hashes the block before it. */
function v2Block(n, prevRaw, overrides = {}) {
  const chain = overrides.chain !== undefined ? overrides.chain : `sha256:${v.sha256(prevRaw)}`;
  const sel = overrides.sel !== undefined ? overrides.sel : '- selection score: 8/10 (10 items).';
  const held = overrides.held !== undefined ? overrides.held : '- held-out score: 7/10 (12 items, never used for selection).';
  const verdict = overrides.verdict !== undefined ? overrides.verdict : '- keep/revert: keep.';
  return `### n=${n} — a new record\n\n${sel}\n${held}\n- prev-chain: ${chain}\n${verdict}\n`;
}

test('parseRecords splits file-order blocks and their exact bytes', () => {
  const one = V1_BLOCK;
  const two = v2Block(11, one);
  const text = one + two;
  const records = v.parseRecords(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].n, 10);
  assert.equal(records[1].n, 11);
  assert.equal(records[0].raw, one);     // exact bytes, header through the next header
  assert.equal(records[1].raw, two);
});

test('parseRecords ignores campaign sub-record headers (depth 4) and prose', () => {
  const text = '# title\n\n#### n=99 — a sub-record\n\n### n=12 — real\n\n- x\n';
  const records = v.parseRecords(text);
  assert.deepEqual(records.map((r) => r.n), [12]);
});

test('maxRecordN is the maximum n, or null when there are no records', () => {
  assert.equal(v.maxRecordN(V1_BLOCK + v2Block(11, V1_BLOCK)), 11);
  assert.equal(v.maxRecordN('no records here\n'), null);
});

test('a new valid record with a correct prev-chain -> clean', () => {
  const text = V1_BLOCK + v2Block(11, V1_BLOCK);
  const r = v.validateLedger(text, 10);
  assert.deepEqual(r.errors, []);
  assert.equal(r.newRecords.length, 1);
  assert.equal(r.newRecords[0].n, 11);
});

test('missing held-out score field is rejected on a new record', () => {
  const block = v2Block(11, V1_BLOCK, { held: '- note: no held-out line here.' });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: missing "held-out score" line/.test(e)));
});

test('keep with an empty held-out score is rejected', () => {
  const block = v2Block(11, V1_BLOCK, { held: '- held-out score (12 items, never used for selection).' });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: "keep" requires a non-empty held-out score/.test(e)));
});

test('a revert with an empty held-out score is tolerated', () => {
  const block = v2Block(11, V1_BLOCK, {
    held: '- held-out score (12 items, never used for selection).',
    verdict: '- keep/revert: revert (ran out of budget).',
  });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.deepEqual(r.errors, []);
});

test('a score line present but with no "(N items)" item count is rejected', () => {
  const block = v2Block(11, V1_BLOCK, { sel: '- selection score: 8/10.' });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: "selection score" has no "\(N items\)" item count/.test(e)));
});

test('a held-out line with a score but no item count is rejected', () => {
  const block = v2Block(11, V1_BLOCK, { held: '- held-out score: 7/10, never used for selection.' });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: "held-out score" has no "\(N items\)" item count/.test(e)));
});

test('missing disjointness declaration is rejected', () => {
  const block = v2Block(11, V1_BLOCK, { held: '- held-out score: 7/10 (12 items).' });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: missing disjointness declaration/.test(e)));
});

test('a broken prev-chain (wrong hash) is rejected', () => {
  const block = v2Block(11, V1_BLOCK, { chain: `sha256:${'0'.repeat(64)}` });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: prev-chain mismatch/.test(e)));
});

test('a malformed prev-chain (wrong length) is rejected', () => {
  const block = v2Block(11, V1_BLOCK, { chain: 'sha256:deadbeef' });
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: prev-chain hex is 8 chars, expected 64/.test(e)));
});

test('a missing prev-chain field is rejected', () => {
  const block = v2Block(11, V1_BLOCK).replace(/- prev-chain: sha256:[0-9a-f]+/, '- chain: absent.');
  const r = v.validateLedger(V1_BLOCK + block, 10);
  assert.ok(r.errors.some((e) => /n=11: missing "prev-chain: sha256:<hex>" field/.test(e)));
});

test('grandfathering: a v1 record already at HEAD max is not checked', () => {
  const text = V1_BLOCK + v2Block(11, V1_BLOCK);
  const r = v.validateLedger(text, 10);
  assert.deepEqual(r.errors, []);                 // the n=10 v1 block trips nothing
  assert.equal(r.records.length, 2);
  assert.equal(r.newRecords.length, 1);           // only n=11 is validated
});

test('grandfathering: no new records -> exit 0 (the normal case)', () => {
  const r = v.validateLedger(V1_BLOCK, 10);
  assert.deepEqual(r.errors, []);
  assert.equal(r.newRecords.length, 0);
});

test('headMax null treats every record as new', () => {
  const r = v.validateLedger(V1_BLOCK, null);
  assert.ok(r.newRecords.length === 1);
  assert.ok(r.errors.length > 0);                 // the v1 block has no v2 fields
});

test('checkRecord chains to the immediately preceding block', () => {
  const text = V1_BLOCK + v2Block(11, V1_BLOCK) + v2Block(12, v2Block(11, V1_BLOCK));
  const records = v.parseRecords(text);
  assert.deepEqual(v.checkRecord(records[2], records[1]), []);
  assert.ok(v.checkRecord(records[2], records[0]).some((e) => /prev-chain mismatch/.test(e)));
});

test('parseArgs defaults, flags, and errors', () => {
  const d = v.parseArgs([]);
  assert.ok(d.ledger.endsWith(path.join('docs', 'agents', 'ledger.md')));
  const f = v.parseArgs(['--ledger', '/tmp/x.md']);
  assert.equal(f.ledger, '/tmp/x.md');
  assert.ok(v.parseArgs(['--ledger']).error);
  assert.ok(v.parseArgs(['--bogus']).error);
});

test('main exit codes: 0 clean, 1 violations, 2 usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-gate-'));
  const clean = path.join(dir, 'clean.md');
  const bad = path.join(dir, 'bad.md');
  // n is far above any committed HEAD max, so both are validated regardless of git.
  fs.writeFileSync(clean, V1_BLOCK + v2Block(99999, V1_BLOCK));
  fs.writeFileSync(bad, V1_BLOCK + v2Block(99999, V1_BLOCK, { chain: `sha256:${'0'.repeat(64)}` }));
  assert.equal(v.main(['--ledger', clean]), 0);
  assert.equal(v.main(['--ledger', bad]), 1);
  assert.equal(v.main(['--bogus']), 2);
});

test('main fails closed on an unreadable ledger', () => {
  assert.equal(v.main(['--ledger', path.join(os.tmpdir(), 'nope-ledger.md')]), 1);
});

test('repoRoot/parseArgs resolve into the cwd repo, not this module (symlink-safe)', () => {
  // The live entry is a symlink back into the dotfiles repo, so rooting on
  // __dirname would read the wrong ledger from a target repo. A real temp git
  // repo, selected via OPENCODE_VALIDATE_ROOT (the index-read.cjs contract),
  // must become the root the default ledger path is built from.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-root-'));
  const saved = process.env.OPENCODE_VALIDATE_ROOT;
  try {
    fs.mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'agents', 'ledger.md'), V1_BLOCK);
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dir });

    process.env.OPENCODE_VALIDATE_ROOT = dir;
    assert.equal(fs.realpathSync(v.repoRoot()), fs.realpathSync(dir));
    assert.equal(v.parseArgs([]).ledger, path.join(dir, 'docs', 'agents', 'ledger.md'));
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_VALIDATE_ROOT;
    else process.env.OPENCODE_VALIDATE_ROOT = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
