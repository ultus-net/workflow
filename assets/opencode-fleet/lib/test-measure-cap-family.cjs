#!/usr/bin/env node
/**
 * test-measure-cap-family.cjs
 *
 * Fixtures for measure-cap-family.cjs — the byte side of the cap decision sliced
 * by producing family. Pins the properties the ledger's n=18 prediction names:
 * per-family sums reconcile to the n=12 aggregate projection, an unresolved file
 * is kept in an explicit `(unknown)` row (never silently dropped), the rate
 * column is the read-back ruler's own bySpillTool value, and absence of the DB
 * is a SKIP while a present-but-unparseable DB is an error.
 *
 * Run: node --test install/lib/test-measure-cap-family.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const m = require('./measure-cap-family.cjs');
const bytes = require('./measure-tool-output.cjs');

const STORE = '/store/tool-output';
const MARKER = '... [truncated] ...';
// An arbitrary synthetic cap for the attribution-math fixtures. Deliberately a
// literal, NOT `bytes.CURRENT_MAX_BYTES`: these tests exercise cap-independent
// properties (reconciliation, the (unknown) row, rate provenance), so coupling
// them to the live cap would only make a cap change churn them. The live cap's
// parity with the overlay is asserted separately in test-measure-tool-output.cjs.
const SYNTH_LINES = 800;
const SYNTH_BYTES = 40000;

/** A synthetic scan file (the shape scanStore emits, text included). */
function file(name, text) {
  return { name, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length, mtime: '1970-01-01T00:00:00.000Z', text };
}

test('attribute: per-family sums reconcile to the n=12 aggregate projection', () => {
  const scan = { files: [file('tool_A', 'a\n'.repeat(5000)), file('tool_B', 'b'.repeat(300)), file('tool_C', 'c\n'.repeat(10))], readErrors: 0 };
  const producers = new Map([
    ['tool_A', { tool: 'webfetch', session: 's', t: 1 }],
    ['tool_B', { tool: 'bash', session: 's', t: 1 }],
    ['tool_C', { tool: 'webfetch', session: 's', t: 1 }],
  ]);
  const cap = m.attribute(scan, producers, {}, SYNTH_LINES, SYNTH_BYTES, MARKER);
  assert.equal(cap.reconciles, true);
  const sum = (k) => Object.values(cap.families).reduce((n, r) => n + r[k], 0);
  assert.equal(sum('files'), scan.files.length);
  assert.equal(sum('retainedBytes'), cap.aggregateRetainedBytes);
  assert.equal(sum('fullBytes'), cap.totals.fullBytes);
});

test('attribute: an unresolved file is kept in the (unknown) row', () => {
  const scan = { files: [file('tool_A', 'x\n'.repeat(5000)), file('tool_ORPHAN', 'y'.repeat(900))], readErrors: 0 };
  const producers = new Map([['tool_A', { tool: 'webfetch', session: 's', t: 1 }]]);
  const cap = m.attribute(scan, producers, {}, SYNTH_LINES, SYNTH_BYTES, MARKER);
  assert.equal(cap.unresolved, 1);
  assert.ok(cap.families[m.UNKNOWN], 'the orphan file must appear as (unknown)');
  assert.equal(cap.families[m.UNKNOWN].files, 1);
  // Nothing dropped: sums still reconcile to the aggregate.
  assert.equal(cap.reconciles, true);
  assert.equal(cap.families[m.UNKNOWN].fullBytes, 900);
});

test('attribute: the rate column is the bySpillTool value, not invented', () => {
  const scan = { files: [file('tool_A', 'a'.repeat(100))], readErrors: 0 };
  const producers = new Map([['tool_A', { tool: 'webfetch', session: 's', t: 1 }]]);
  const rates = { webfetch: { spills: 4, reopened: 1, rate: 0.25 } };
  const cap = m.attribute(scan, producers, rates, SYNTH_LINES, SYNTH_BYTES, MARKER);
  assert.equal(cap.families.webfetch.reopened, 1);
  assert.equal(cap.families.webfetch.rate, 0.25);
});

test('attribute: a family with no measured rate is null, not zero', () => {
  const scan = { files: [file('tool_A', 'a'.repeat(100))], readErrors: 0 };
  const producers = new Map([['tool_A', { tool: 'bash', session: 's', t: 1 }]]);
  const cap = m.attribute(scan, producers, {}, SYNTH_LINES, SYNTH_BYTES, MARKER);
  assert.equal(cap.families.bash.rate, null);
  assert.equal(cap.families.bash.reopened, null);
});

test('attribute: a tighter cap removes strictly more bytes and never adds retained', () => {
  const scan = { files: [file('tool_A', 'a\n'.repeat(9000)), file('tool_B', 'b'.repeat(60000))], readErrors: 0 };
  const producers = new Map([['tool_A', { tool: 'webfetch' }], ['tool_B', { tool: 'bash' }]]);
  const loose = m.attribute(scan, producers, {}, 2000, 51200, MARKER);
  const tight = m.attribute(scan, producers, {}, SYNTH_LINES, SYNTH_BYTES, MARKER);
  assert.ok(tight.totals.retainedBytes <= loose.totals.retainedBytes);
  assert.ok(tight.totals.removedBytes >= loose.totals.removedBytes);
  for (const fam of Object.keys(loose.families)) {
    assert.ok(tight.families[fam].retainedBytes <= loose.families[fam].retainedBytes, fam);
  }
});

test('attribute: files within both limits pass through unchanged', () => {
  const scan = { files: [file('tool_A', 'short\nline')], readErrors: 0 };
  const producers = new Map([['tool_A', { tool: 'webfetch' }]]);
  const cap = m.attribute(scan, producers, {}, SYNTH_LINES, SYNTH_BYTES, MARKER);
  assert.equal(cap.families.webfetch.retainedBytes, scan.files[0].bytes);
  assert.equal(cap.families.webfetch.removedBytes, 0);
  assert.equal(cap.families.webfetch.inlined, 1);
  assert.equal(cap.families.webfetch.spilled, 0);
});

test('projectFamilies: carries the settings label and de-duplicates settings', () => {
  const seen = m.defaultSettings([{ maxLines: SYNTH_LINES, maxBytes: SYNTH_BYTES }, { maxLines: 100, maxBytes: 1000 }]);
  const keys = seen.map((s) => `${s.maxLines}/${s.maxBytes}`);
  assert.deepEqual(keys, [...new Set(keys)], 'settings must be de-duplicated');
  assert.equal(seen[0].label, 'default');
  assert.equal(seen[1].label, 'current');
  assert.ok(seen.some((s) => s.maxLines === 100 && s.maxBytes === 1000));
  // An omitted list is the default/current pair, not a throw.
  assert.deepEqual(m.defaultSettings().map((s) => s.label), ['default', 'current']);
});

test('parseArgs: rejects malformed settings and unknown flags', () => {
  assert.match(m.parseArgs(['--settings', 'nope']).error, /invalid --settings/);
  assert.match(m.parseArgs(['--bogus']).error, /unknown argument/);
  assert.match(m.parseArgs(['--store']).error, /--store requires/);
});

test('measure: missing DB is a SKIP, not an error', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capfam-'));
  fs.writeFileSync(path.join(storeDir, 'tool_A'), 'hello\n'.repeat(5000));
  const r = m.measure({ store: storeDir, dbPath: path.join(os.tmpdir(), 'capfam-absent-' + Date.now()) });
  assert.equal(r.error, null);
  assert.match(r.skipped, /no store at/);
  fs.rmSync(storeDir, { recursive: true, force: true });
});

test('measure: end-to-end temp store + DB attributes a family and reconciles', () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capfam-store-'));
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capfam-db-')), 'oc.db');
  const big = 'line\n'.repeat(12000); // > both caps
  const small = 'tiny';
  fs.writeFileSync(path.join(storeDir, 'tool_SPILL'), big);
  fs.writeFileSync(path.join(storeDir, 'tool_TINY'), small);

  const D = require('node:sqlite');
  const db = new D.DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
  const part = (name, outputPath) => JSON.stringify({ content: [{ type: 'tool', name, state: { input: {}, metadata: { outputPath } } }] });
  const readback = (name, filePath) => JSON.stringify({ content: [{ type: 'tool', name, state: { input: { filePath } } }] });
  // Spill tool_SPILL with webfetch, then re-open it: the rate must flow through
  // `measure` from `effect.analyze(...).bySpillTool`, not from a stub.
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', part('webfetch', `${STORE}/tool_SPILL`), 1000);
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('2', 's1', 'assistant', readback('read', `${STORE}/tool_SPILL`), 2000);
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('3', 's1', 'assistant', part('bash', `${STORE}/tool_TINY`), 1000);
  db.close();

  const r = m.measure({ store: storeDir, dbPath, settings: [{ maxLines: SYNTH_LINES, maxBytes: SYNTH_BYTES }] });
  assert.equal(r.error, null);
  assert.ok(r.producers >= 1);
  const cur = r.projections.find((p) => p.maxLines === SYNTH_LINES && p.maxBytes === SYNTH_BYTES);
  assert.equal(cur.reconciles, true);
  assert.ok(cur.families.webfetch, 'the spilled file must be attributed to webfetch');
  assert.equal(cur.families.webfetch.files, 1);
  // End-to-end rate provenance: webfetch spilled once and was re-opened once.
  assert.equal(cur.families.webfetch.reopened, 1);
  assert.equal(cur.families.webfetch.rate, 1);
  // bash spilled but was never re-opened.
  assert.equal(cur.families.bash.reopened, 0);
  assert.equal(cur.families.bash.rate, 0);

  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
