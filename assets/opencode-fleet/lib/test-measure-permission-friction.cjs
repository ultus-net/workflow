#!/usr/bin/env node
/**
 * test-measure-permission-friction.cjs
 *
 * Fixtures for measure-permission-friction.cjs. Pins the ruler against
 * hand-computed synthetic row JSON and real temp SQLite stores: the row parse
 * (a denied call is keyed on `state.error.type`, never on message text), the
 * fail-loud contract on a malformed row, the class/tool/agent/path-root splits,
 * the unit-vs-session distinction, and the skip-on-absent-store path. The
 * critical fixture is `a non-permission error is not counted`: it pins the
 * structural key so an execution error cannot inflate the denial census.
 *
 * Run: node --test install/lib/test-measure-permission-friction.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const m = require('./measure-permission-friction.cjs');

// A row with one denied tool item.
const denyRow = (over = {}, itemOver = {}) => JSON.stringify({
  time: { created: 1000 },
  agent: 'reviewer',
  content: [{
    type: 'tool',
    name: 'read',
    state: { status: 'error', input: { path: '/home/hunter/proj/a.ts' }, error: { type: 'permission.rejected', message: 'Permission denied: external_directory' } },
    ...itemOver,
  }],
  ...over,
});

// ─── pure helpers ────────────────────────────────────────────────────────────

test('safeJson: returns null on malformed, parses valid', () => {
  assert.equal(m.safeJson('{not json'), null);
  assert.deepEqual(m.safeJson('{"a":1}'), { a: 1 });
});

test('denialClass: strips the prefix, names an empty or non-string message', () => {
  assert.equal(m.denialClass('Permission denied: shell'), 'shell');
  assert.equal(m.denialClass('Permission denied:  external_directory '), 'external_directory');
  assert.equal(m.denialClass('Permission denied: '), '(unnamed)');
  assert.equal(m.denialClass(undefined), '(unnamed)');
});

test('pathRoot: aggregates to three segments, handles short/root/empty', () => {
  assert.equal(m.pathRoot('/a/b/c/d/e.ts'), '/a/b/c');
  assert.equal(m.pathRoot('/a/b'), '/a/b');
  assert.equal(m.pathRoot('/a'), '/a');
  assert.equal(m.pathRoot('/'), '/');
  assert.equal(m.pathRoot(''), null);
  assert.equal(m.pathRoot(42), null);
});

test('denialTarget: a path is a path, a command is not', () => {
  assert.deepEqual(m.denialTarget({ path: '/x/y' }), { value: '/x/y', kind: 'path' });
  assert.deepEqual(m.denialTarget({ pattern: '**/*.ts' }), { value: '**/*.ts', kind: 'pattern' });
  assert.deepEqual(m.denialTarget({ command: 'ls -la /var/home' }), { value: 'ls -la /var/home', kind: 'command' });
  assert.equal(m.denialTarget({}), null);
  assert.equal(m.denialTarget(null), null);
});

test('denialsFromRow: a denied call is parsed with its class/tool/root', () => {
  const rows = m.denialsFromRow(denyRow());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'read');
  assert.equal(rows[0].cls, 'external_directory');
  assert.equal(rows[0].root, '/home/hunter/proj');
  assert.equal(rows[0].agent, 'reviewer');
  assert.equal(rows[0].t, 1000);
});

test('denialsFromRow: a non-permission error is not counted', () => {
  const row = denyRow({}, { state: { status: 'error', error: { type: 'execution', message: 'boom' } } });
  assert.deepEqual(m.denialsFromRow(row), [], 'keyed on error.type, not on message text');
});

test('denialsFromRow: a completed call is not counted', () => {
  const row = denyRow({}, { state: { status: 'completed', error: { type: 'permission.rejected', message: 'Permission denied: x' } } });
  assert.deepEqual(m.denialsFromRow(row), []);
});

test('denialsFromRow: a command denial contributes no path root', () => {
  const row = denyRow({}, { name: 'shell', state: { status: 'error', input: { command: 'ls -la /var/home' }, error: { type: 'permission.rejected', message: 'Permission denied: shell' } } });
  const rows = m.denialsFromRow(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetKind, 'command');
  assert.equal(rows[0].root, null, 'a shell command never becomes a path root');
});

test('denialsFromRow: a non-object row is null (fail-loud signal)', () => {
  assert.equal(m.denialsFromRow('{bad json'), null);
  assert.equal(m.denialsFromRow('[]'), null);
  assert.equal(m.denialsFromRow('null'), null);
});

test('denialsFromLegacyPart: a legacy tool part IS the object (no content wrapper)', () => {
  const part = JSON.stringify({ type: 'tool', name: 'glob', time: { created: 77 }, state: { status: 'error', input: { path: '/a/b/c' }, error: { type: 'permission.rejected', message: 'Permission denied: external_directory' } } });
  const rows = m.denialsFromLegacyPart(part);
  assert.equal(rows.length, 1, 'the v2 reader would return zero here — the bug this parser prevents');
  assert.equal(rows[0].tool, 'glob');
  assert.equal(rows[0].cls, 'external_directory');
  assert.equal(rows[0].t, 77);
  assert.deepEqual(m.denialsFromRow(part), [], 'the v2 reader sees no content[] and returns empty');
});

test('denialsFromLegacyPart: a non-tool part and a malformed row', () => {
  assert.deepEqual(m.denialsFromLegacyPart(JSON.stringify({ type: 'text', text: 'x' })), []);
  assert.equal(m.denialsFromLegacyPart('{bad json'), null);
});

test('denialsFromRow: several denied calls in one row are all counted', () => {
  const row = JSON.stringify({
    time: { created: 1 }, agent: 'reviewer',
    content: [
      { type: 'tool', name: 'read', state: { status: 'error', input: { path: '/a/b/c' }, error: { type: 'permission.rejected', message: 'Permission denied: external_directory' } } },
      { type: 'tool', name: 'glob', state: { status: 'error', input: { path: '/a/b/c' }, error: { type: 'permission.rejected', message: 'Permission denied: external_directory' } } },
      { type: 'text', text: 'ignored' },
    ],
  });
  assert.equal(m.denialsFromRow(row).length, 2);
});

// ─── summarize (hand-computed) ───────────────────────────────────────────────

const D = (over) => ({ tool: 'read', cls: 'external_directory', target: '/a/b/c', targetKind: 'path', root: '/a/b/c', agent: 'reviewer', t: 1, session: 's1', ...over });

test('summarize: units and distinct sessions are reported separately', () => {
  const s = m.summarize([D({ session: 's1' }), D({ session: 's1' }), D({ session: 's2' })]);
  assert.equal(s.denials, 3, 'three denied calls');
  assert.equal(s.sessions, 2, 'over two sessions');
});

test('summarize: class/tool/agent/root splits', () => {
  const s = m.summarize([
    D({ cls: 'external_directory', tool: 'read', agent: 'reviewer', root: '/a/b/c' }),
    D({ cls: 'external_directory', tool: 'glob', agent: 'reviewer', root: '/a/b/c' }),
    D({ cls: 'shell', tool: 'shell', agent: 'explore', root: null, targetKind: 'command' }),
  ]);
  assert.deepEqual(s.byClass, { external_directory: 2, shell: 1 });
  assert.deepEqual(s.byTool, { read: 1, glob: 1, shell: 1 });
  assert.deepEqual(s.byAgent, { reviewer: 2, explore: 1 });
  assert.deepEqual(s.byRoot, { '/a/b/c': 2 });
  assert.deepEqual(s.byTargetKind, { path: 2, command: 1 });
});

test('summarize: a null root never enters the root histogram', () => {
  const s = m.summarize([D({ root: null, targetKind: 'command' }), D({ root: '/x/y/z' })]);
  assert.deepEqual(s.byRoot, { '/x/y/z': 1 });
});

test('summarize: several denials in one session collapse to one distinct session', () => {
  const denials = [];
  for (let i = 0; i < 3; i++) denials.push(D({ session: 'hot' }));
  denials.push(D({ session: 'other' }));
  const s = m.summarize(denials);
  assert.equal(s.denials, 4);
  assert.equal(s.sessions, 2);
});

test('summarize: window span from the fire times', () => {
  const s = m.summarize([D({ t: 0 }), D({ t: 864e5 * 2 })]);
  assert.equal(s.earliest, 0);
  assert.equal(s.latest, 864e5 * 2);
  assert.equal(s.spanDays, 2);
});

test('summarize: empty input is null-safe', () => {
  const s = m.summarize([]);
  assert.equal(s.denials, 0);
  assert.equal(s.sessions, 0);
  assert.equal(s.earliest, null);
  assert.equal(s.spanDays, null);
  assert.deepEqual(s.byRoot, {});
});

// ─── readDenials (real temp SQLite) ──────────────────────────────────────────

function makeDb(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permfric-'));
  const p = path.join(dir, 'oc.db');
  const D2 = require('node:sqlite');
  const db = new D2.DatabaseSync(p);
  build(db);
  db.close();
  return p;
}

const MSG = 'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)';
const insMsg = (db) => db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)');
const SESS = 'CREATE TABLE session_v2 (id TEXT, agent TEXT)';
const insSess = (db) => db.prepare('INSERT INTO session_v2 VALUES (?,?)');

test('readDenials: missing store is a skip, not an error', () => {
  const r = m.readDenials(path.join(os.tmpdir(), 'permfric-absent-' + Date.now()), null);
  assert.match(r.skipped, /no store at/);
  assert.equal(r.error, null);
});

test('readDenials: reads denied rows and joins the agent', () => {
  const p = makeDb((db) => {
    db.exec(MSG); db.exec(SESS);
    insSess(db).run('s1', 'reviewer');
    insMsg(db).run('1', 's1', 'assistant', denyRow(), 1000);
    insMsg(db).run('2', 's1', 'assistant', JSON.stringify({ content: [{ type: 'tool', name: 'read', state: { status: 'completed' } }] }), 1500); // not denied
  });
  const r = m.readDenials(p, null);
  assert.equal(r.error, null);
  assert.equal(r.denials.length, 1);
  assert.equal(r.denials[0].agent, 'reviewer');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readDenials: the row agent wins, the session join is a fallback', () => {
  const p = makeDb((db) => {
    db.exec(MSG); db.exec(SESS);
    insSess(db).run('s1', 'screener');
    // Row omits agent -> fallback to the session join.
    insMsg(db).run('1', 's1', 'assistant', JSON.stringify({ content: [{ type: 'tool', name: 'read', state: { status: 'error', input: { path: '/a/b/c' }, error: { type: 'permission.rejected', message: 'Permission denied: x' } } }] }), 1000);
  });
  const r = m.readDenials(p, null);
  assert.equal(r.denials[0].agent, 'screener');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readDenials: a malformed row is format drift (error)', () => {
  const p = makeDb((db) => {
    db.exec(MSG);
    insMsg(db).run('1', 's1', 'assistant', denyRow(), 900);
    insMsg(db).run('2', 's1', 'assistant', '{bad json permission.rejected', 1000);
  });
  const r = m.readDenials(p, null);
  assert.match(r.error, /unparseable/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readDenials: since filters by time_created, and the reported t is the row column', () => {
  const p = makeDb((db) => {
    db.exec(MSG);
    // The JSON time and the row time_created DIFFER: the filter and the reported
    // span must both use the row column, so they can never disagree.
    insMsg(db).run('1', 's1', 'assistant', denyRow({ time: { created: 111 } }), 1000);
    insMsg(db).run('2', 's1', 'assistant', denyRow({ time: { created: 222 } }), 5000);
  });
  const r = m.readDenials(p, 3000);
  assert.equal(r.denials.length, 1);
  assert.equal(r.denials[0].t, 5000, 'the reported time is the row column, not the JSON time.created');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readDenials: a legacy-only `part` store is read, not reported as zero', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE part (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)');
    db.exec(SESS);
    insSess(db).run('s1', 'reviewer');
    // A legacy part row: data IS the tool part object, not a {content:[]} wrapper.
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('1', 's1',
      JSON.stringify({ type: 'tool', name: 'read', state: { status: 'error', input: { path: '/a/b/c' }, error: { type: 'permission.rejected', message: 'Permission denied: external_directory' } } }), 1000);
  });
  const r = m.readDenials(p, null);
  assert.equal(r.error, null);
  assert.equal(r.denials.length, 1, 'the legacy parser finds the denial the v2 reader would miss');
  assert.equal(r.denials[0].agent, 'reviewer', 'the agent comes from the session join (a part row has none)');
  assert.equal(r.denials[0].tool, 'read');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('measure: skip and error propagate; success spreads summarize', () => {
  assert.match(m.measure({ dbPath: path.join(os.tmpdir(), 'permfric-none-' + Date.now()) }).skipped, /no store at/);
  const p = makeDb((db) => {
    db.exec(MSG);
    insMsg(db).run('1', 's1', 'assistant', denyRow(), 1000);
    insMsg(db).run('2', 's1', 'assistant', denyRow({ agent: 'explore' }, { name: 'glob' }), 2000);
  });
  const res = m.measure({ dbPath: p });
  assert.equal(res.error, null);
  assert.equal(res.denials, 2);
  assert.deepEqual(res.byAgent, { reviewer: 1, explore: 1 });
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test('parseArgs: rejects bad --db/--since, accepts --all (which overrides --since)', () => {
  assert.match(m.parseArgs(['--db']).error, /--db requires/);
  assert.match(m.parseArgs(['--since', 'not-a-date']).error, /invalid --since/);
  const o = m.parseArgs(['--all']);
  assert.equal(o.since, null);
  assert.equal(m.parseArgs(['--all', '--since', '2026-09-11T00:00:00Z']).since, null, '--all overrides --since');
  assert.ok(m.parseArgs([]).since < Date.now(), 'default window is bounded');
});

test('main: a missing store skips and exits 0', () => {
  assert.equal(m.main(['--db', path.join(os.tmpdir(), 'permfric-absent-' + Date.now())]), 0);
});
