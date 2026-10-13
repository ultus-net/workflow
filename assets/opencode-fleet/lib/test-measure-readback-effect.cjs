#!/usr/bin/env node
/**
 * test-measure-readback-effect.cjs
 *
 * Fixtures for measure-readback-effect.cjs. Pins the detection against
 * hand-computed synthetic session_message / legacy part JSON and real temp
 * SQLite stores: spill = metadata.outputPath into the store; read-back = an
 * input referencing a store id; matched/same-session accounting; and the
 * skip-vs-error store contract.
 *
 * Run: node --test install/lib/test-measure-readback-effect.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const m = require('./measure-readback-effect.cjs');

const STORE = '/home/hunter/.local/share/opencode/tool-output';
const toolPart = (name, state) => ({ type: 'tool', name, state });
const msg = (content) => JSON.stringify({ content });

// ─── pure helpers ────────────────────────────────────────────────────────────

test('safeJson: returns null on malformed, parses valid', () => {
  assert.equal(m.safeJson('{not json'), null);
  assert.deepEqual(m.safeJson('{"a":1}'), { a: 1 });
});

test('storeIdOf: extracts an id only from a store path', () => {
  assert.equal(m.storeIdOf(`${STORE}/tool_abc123`), 'tool_abc123');
  assert.equal(m.storeIdOf('/tmp/other/tool_abc123'), null);
  assert.equal(m.storeIdOf(null), null);
});

test('normalizePart: keeps tool parts, drops others', () => {
  const p = m.normalizePart(toolPart('read', { input: { filePath: 'x' }, output: 'ok', metadata: { truncated: true } }));
  assert.equal(p.tool, 'read');
  assert.deepEqual(p.input, { filePath: 'x' });
  assert.equal(p.output, 'ok');
  assert.deepEqual(p.metadata, { truncated: true });
  assert.equal(m.normalizePart({ type: 'text', text: 'hi' }), null);
  assert.equal(m.normalizePart(null), null);
});

test('partsFromSessionMessage: only tool parts from content[]', () => {
  const parts = m.partsFromSessionMessage(msg([
    { type: 'reasoning', text: 'x' },
    toolPart('grep', { input: { pattern: 'a' } }),
    toolPart('read', { input: { filePath: 'y' } }),
  ]));
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.tool), ['grep', 'read']);
  assert.deepEqual(m.partsFromSessionMessage('{bad'), []);
  assert.deepEqual(m.partsFromSessionMessage(JSON.stringify({ content: 'nope' })), []);
});

test('partsFromLegacyPart: the row data is itself a part', () => {
  assert.equal(m.partsFromLegacyPart(JSON.stringify(toolPart('bash', { input: { command: 'ls' } }))).length, 1);
  assert.deepEqual(m.partsFromLegacyPart(JSON.stringify({ type: 'text' })), []);
});

test('isSpill: metadata.outputPath into the store, not a framework path', () => {
  assert.equal(m.isSpill({ metadata: { outputPath: `${STORE}/tool_x1` } }), true);
  assert.equal(m.isSpill({ metadata: { truncated: true } }), false);
  assert.equal(m.isSpill({ metadata: { outputPath: '/tmp/framework/out.txt' } }), false);
});

test('readbackIds: every store id referenced by the input', () => {
  const p = { input: { command: `cat ${STORE}/tool_a1 ${STORE}/tool_b2`, workdir: '/x' } };
  assert.deepEqual(m.readbackIds(p).sort(), ['tool_a1', 'tool_b2']);
  assert.deepEqual(m.readbackIds({ input: { pattern: 'no store here' } }), []);
});

// ─── analyze (hand-computed) ─────────────────────────────────────────────────

test('analyze: distinct-file rates and refs-per-spill are separate', () => {
  const t1 = Date.parse('2026-09-10T00:00:00Z');
  const t2 = Date.parse('2026-09-11T00:00:00Z');
  const parts = [
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_A` } })), session: 's1', t: t1 }, // spill A
    { ...m.normalizePart(toolPart('read', { input: { filePath: `${STORE}/tool_A` } })), session: 's1', t: t2 },      // read-back A (same)
    { ...m.normalizePart(toolPart('grep', { input: { path: `${STORE}/tool_B` } })), session: 's1', t: t2 },          // read-back B (no spill)
    { ...m.normalizePart(toolPart('shell', { metadata: { outputPath: `${STORE}/tool_C` } })), session: 's2', t: t2 },// spill C
    { ...m.normalizePart(toolPart('task', { input: { prompt: `see ${STORE}/tool_A` } })), session: 's2', t: t2 },   // read-back A (cross-session)
  ];
  const a = m.analyze(parts);
  assert.equal(a.tools, 5);
  assert.equal(a.spills, 2);            // A, C
  assert.equal(a.readbacks, 3);         // A, B, A
  assert.equal(a.refsMatched, 2);       // A (s1), A (s2)
  assert.equal(a.refsSameSession, 1);   // A (s1)
  assert.equal(a.distinctFiles, 1);     // A
  assert.equal(a.distinctSameSession, 1);
  assert.equal(a.reopenedRate, 0.5);           // 1 distinct file / 2 spills
  assert.equal(a.sameSessionRate, 0.5);        // 1 same-session file / 2 spills
  assert.equal(a.refsPerSpill, 1);             // 2 refs / 2 spills
  assert.equal(a.sameSessionRefsPerSpill, 0.5);
  assert.deepEqual(a.byTool, { read: 1, task: 1 });
  assert.deepEqual(a.byDay['2026-09-10'], { tools: 1, spills: 1, readbacks: 0 });
  assert.deepEqual(a.byDay['2026-09-11'], { tools: 4, spills: 1, readbacks: 3 });
});

test('analyze: a reference that precedes the spill is not a read-back', () => {
  const t1 = Date.parse('2026-09-10T00:00:00Z');
  const t2 = Date.parse('2026-09-11T00:00:00Z');
  const parts = [
    { ...m.normalizePart(toolPart('read', { input: { filePath: `${STORE}/tool_A` } })), session: 's1', t: t1 },      // earlier
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_A` } })), session: 's1', t: t2 }, // spill later
  ];
  const a = m.analyze(parts);
  assert.equal(a.refsMatched, 0, 'a read-back cannot precede its spill');
  assert.equal(a.distinctFiles, 0);
});

test('analyze: N ids in one call count as N references but 1 distinct file', () => {
  const t1 = Date.parse('2026-09-10T00:00:00Z');
  const t2 = Date.parse('2026-09-11T00:00:00Z');
  const parts = [
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_A` } })), session: 's', t: t1 },
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_B` } })), session: 's', t: t1 },
    { ...m.normalizePart(toolPart('shell', { input: { command: `cat ${STORE}/tool_A ${STORE}/tool_B` } })), session: 's', t: t2 },
  ];
  const a = m.analyze(parts);
  assert.equal(a.refsMatched, 2);   // two references
  assert.equal(a.distinctFiles, 2); // two files
  assert.equal(a.refsPerSpill, 1);  // 2 / 2 spills
  assert.equal(a.reopenedRate, 1);  // 2 files / 2 spills
});

test('analyze: zero spills yields zero rates, not NaN', () => {
  const parts = [{ ...m.normalizePart(toolPart('read', { input: { filePath: 'x' } })), session: 's', t: Date.now() }];
  const a = m.analyze(parts);
  assert.equal(a.spills, 0);
  assert.equal(a.reopenedRate, 0);
  assert.equal(a.refsPerSpill, 0);
  assert.equal(a.sameSessionRate, 0);
  assert.deepEqual(a.bySpillTool, {});
});

test('analyze: bySpillTool slices the rate by the spill-producing tool', () => {
  const t1 = Date.parse('2026-09-10T00:00:00Z');
  const t2 = Date.parse('2026-09-11T00:00:00Z');
  const parts = [
    // bash spills A and B; only A is re-opened -> 1/2 = 50%
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_A` } })), session: 's', t: t1 },
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_B` } })), session: 's', t: t1 },
    // webfetch spills C; re-opened -> 1/1 = 100%
    { ...m.normalizePart(toolPart('webfetch', { metadata: { outputPath: `${STORE}/tool_C` } })), session: 's', t: t1 },
    // a read of A (bash) and C (webfetch)
    { ...m.normalizePart(toolPart('read', { input: { filePath: `${STORE}/tool_A` } })), session: 's', t: t2 },
    { ...m.normalizePart(toolPart('read', { input: { filePath: `${STORE}/tool_C` } })), session: 's', t: t2 },
  ];
  const a = m.analyze(parts);
  assert.equal(a.reopenedRate, 2 / 3); // A and C of three spills
  // Sorted by spill count desc: bash (2) then webfetch (1).
  assert.deepEqual(Object.keys(a.bySpillTool), ['bash', 'webfetch']);
  assert.deepEqual(a.bySpillTool.bash, { spills: 2, reopened: 1, rate: 0.5 });
  assert.deepEqual(a.bySpillTool.webfetch, { spills: 1, reopened: 1, rate: 1 });
});

test('analyze: bySpillTool counts distinct files, not references', () => {
  const t1 = Date.parse('2026-09-10T00:00:00Z');
  const t2 = Date.parse('2026-09-11T00:00:00Z');
  const parts = [
    { ...m.normalizePart(toolPart('webfetch', { metadata: { outputPath: `${STORE}/tool_A` } })), session: 's', t: t1 },
    // two separate reads of the same spilled file: 2 references, 1 distinct file
    { ...m.normalizePart(toolPart('read', { input: { filePath: `${STORE}/tool_A` } })), session: 's', t: t2 },
    { ...m.normalizePart(toolPart('grep', { input: { path: `${STORE}/tool_A` } })), session: 's', t: t2 },
  ];
  const a = m.analyze(parts);
  assert.equal(a.refsMatched, 2);
  assert.equal(a.distinctFiles, 1);
  assert.deepEqual(a.bySpillTool.webfetch, { spills: 1, reopened: 1, rate: 1 });
});

test('analyze: a spill-producing tool with no re-open reports rate 0', () => {
  const t1 = Date.parse('2026-09-10T00:00:00Z');
  const parts = [
    { ...m.normalizePart(toolPart('guard_review_followups', { metadata: { outputPath: `${STORE}/tool_X` } })), session: 's', t: t1 },
  ];
  const a = m.analyze(parts);
  assert.deepEqual(a.bySpillTool.guard_review_followups, { spills: 1, reopened: 0, rate: 0 });
});

test('analyze: bySpillTool denominators are distinct store ids, like the aggregate', () => {
  const t1 = Date.parse('2026-09-10T00:00:00Z');
  const parts = [
    // the SAME store id spilled twice; per-tool denominators must not double-count
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_D` } })), session: 's', t: t1 },
    { ...m.normalizePart(toolPart('webfetch', { metadata: { outputPath: `${STORE}/tool_D` } })), session: 's', t: t1 },
    { ...m.normalizePart(toolPart('webfetch', { metadata: { outputPath: `${STORE}/tool_E` } })), session: 's', t: t1 },
  ];
  const a = m.analyze(parts);
  assert.equal(a.spills, 2, 'aggregate counts distinct ids');
  const perToolSum = Object.values(a.bySpillTool).reduce((n, b) => n + b.spills, 0);
  assert.equal(perToolSum, a.spills, 'per-tool denominators sum to the aggregate');
});

test('weekStartOf: buckets any timestamp into a 7-day UTC window', () => {
  const w = m.weekStartOf(Date.parse('2026-09-10T12:00:00Z'));
  assert.equal(w % m.WEEK_MS, 0);
  assert.notEqual(m.weekStartOf(Date.parse('2026-09-17T12:00:00Z')), w); // 7d later: next bucket
  assert.equal(m.weekStartOf(Date.parse('2026-09-16T12:00:00Z')), w);    // 6d later: same bucket
});

test('analyze: byWeek buckets by the spill week and sums to the aggregate', () => {
  // Epoch-anchored buckets are 7 days wide; derive same/next-bucket times from a
  // known bucket start so the fixture does not depend on a calendar weekday.
  const w1 = m.weekStartOf(Date.parse('2026-09-08T00:00:00Z'));
  const A = w1;                    // start of week 1
  const B = w1 + 3 * 864e5;        // 3 days later, same 7d bucket
  const w2 = w1 + m.WEEK_MS;       // start of the next bucket
  const C = w2 + 864e5;            // 1 day into week 2
  assert.equal(m.weekStartOf(A), w1);
  assert.equal(m.weekStartOf(B), w1);
  assert.equal(m.weekStartOf(C), w2);
  const parts = [
    { ...m.normalizePart(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_A` } })), session: 's', t: A },
    // a SECOND family in the same week, so the per-week per-tool partition is
    // exercised with more than one key in the map
    { ...m.normalizePart(toolPart('webfetch', { metadata: { outputPath: `${STORE}/tool_B` } })), session: 's', t: B },
    { ...m.normalizePart(toolPart('webfetch', { metadata: { outputPath: `${STORE}/tool_C` } })), session: 's', t: C },
    // re-open A (week 1) and C (week 2)
    { ...m.normalizePart(toolPart('read', { input: { filePath: `${STORE}/tool_A` } })), session: 's', t: C },
    { ...m.normalizePart(toolPart('read', { input: { filePath: `${STORE}/tool_C` } })), session: 's', t: C },
  ];
  const a = m.analyze(parts);
  const keys = Object.keys(a.byWeek);
  assert.equal(keys.length, 2, 'two spill weeks');
  const sum = Object.values(a.byWeek).reduce((n, b) => n + b.spills, 0);
  assert.equal(sum, a.spills, 'weekly spills sum to the aggregate');
  const week1 = new Date(w1).toISOString().slice(0, 10);
  const week2 = new Date(w2).toISOString().slice(0, 10);
  assert.equal(a.byWeek[week1].spills, 2);
  assert.equal(a.byWeek[week1].reopened, 1);
  assert.equal(a.byWeek[week1].rate, 0.5);                                  // A+B, A re-opened
  // two families in week 1, each with its own rate; sorted by spills desc then insertion
  assert.deepEqual(a.byWeek[week1].bySpillTool, {
    bash: { spills: 1, reopened: 1, rate: 1 },
    webfetch: { spills: 1, reopened: 0, rate: 0 },
  });
  assert.equal(a.byWeek[week2].spills, 1);
  assert.equal(a.byWeek[week2].reopened, 1);
  assert.equal(a.byWeek[week2].rate, 1);                                    // C re-opened
  assert.deepEqual(a.byWeek[week2].bySpillTool, { webfetch: { spills: 1, reopened: 1, rate: 1 } });
  // per-tool weekly partition: each week's tool spills sum to that week's spills
  for (const b of Object.values(a.byWeek)) {
    const toolSum = Object.values(b.bySpillTool).reduce((n, s) => n + s.spills, 0);
    assert.equal(toolSum, b.spills, 'weekly per-tool spills sum to the week');
  }
  assert.deepEqual(keys, [week1, week2]); // ascending by week start
});

test('analyze: byWeek is empty when there are no spills', () => {
  const parts = [{ ...m.normalizePart(toolPart('read', { input: { filePath: 'x' } })), session: 's', t: Date.now() }];
  assert.deepEqual(m.analyze(parts).byWeek, {});
});

// ─── readToolParts (real temp SQLite) ────────────────────────────────────────

function makeDb(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readback-'));
  const p = path.join(dir, 'oc.db');
  const D = require('node:sqlite');
  const db = new D.DatabaseSync(p);
  build(db);
  db.close();
  return p;
}

test('readToolParts: missing store is a skip, not an error', () => {
  const r = m.readToolParts(path.join(os.tmpdir(), 'readback-absent-' + Date.now()), null);
  assert.match(r.skipped, /no store at/);
  assert.equal(r.error, null);
});

test('readToolParts: reads session_message tool parts', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', msg([toolPart('read', { input: { filePath: `${STORE}/tool_A` } })]), 1000);
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('2', 's1', 'user', '{}', 1001); // not assistant
  });
  const r = m.readToolParts(p, null);
  assert.equal(r.error, null);
  assert.equal(r.parts.length, 1);
  assert.equal(r.parts[0].tool, 'read');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readToolParts: falls back to the legacy part table', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE part (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('1', 's1', JSON.stringify(toolPart('bash', { metadata: { outputPath: `${STORE}/tool_Z` } })), 1000);
  });
  const r = m.readToolParts(p, null);
  assert.equal(r.error, null);
  assert.equal(r.parts.length, 1);
  assert.equal(m.isSpill(r.parts[0]), true);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readToolParts: any unparseable row is format drift (error)', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', msg([toolPart('read', { input: { filePath: 'x' } })]), 900);
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('2', 's1', 'assistant', '{bad json', 1000);
  });
  const r = m.readToolParts(p, null);
  assert.match(r.error, /unparseable/); // partial drift must not silently under-count
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readToolParts: legacy part partial drift also fails loud', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE part (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('1', 's1', JSON.stringify(toolPart('bash', { input: { command: 'ls' } })), 900);
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('2', 's1', 'not json', 1000);
  });
  const r = m.readToolParts(p, null);
  assert.match(r.error, /unparseable/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('measure: skip and error propagate; success spreads analyze', () => {
  assert.match(m.measure({ dbPath: path.join(os.tmpdir(), 'readback-none-' + Date.now()) }).skipped, /no store at/);
  const p = makeDb((db) => {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', msg([toolPart('bash', { metadata: { outputPath: `${STORE}/tool_Q` } })]), 1000);
  });
  const res = m.measure({ dbPath: p });
  assert.equal(res.error, null);
  assert.equal(res.spills, 1);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test('parseArgs: rejects bad --db/--since, accepts --all (which overrides --since)', () => {
  assert.match(m.parseArgs(['--db']).error, /--db requires/);
  assert.match(m.parseArgs(['--since', 'not-a-date']).error, /invalid --since/);
  const o = m.parseArgs(['--all']);
  assert.equal(o.since, null);
  assert.equal(o.all, true);
  assert.equal(m.parseArgs(['--all', '--since', '2026-09-11T00:00:00Z']).since, null, '--all overrides --since');
  const d = m.parseArgs([]);
  assert.ok(d.since < Date.now(), 'default window is bounded');
  assert.equal(m.parseArgs(['--bucket-week']).bucketWeek, true);
  assert.equal(m.parseArgs([]).bucketWeek, false);
});

test('main: a missing store skips and exits 0', () => {
  assert.equal(m.main(['--db', path.join(os.tmpdir(), 'readback-absent-' + Date.now())]), 0);
});
