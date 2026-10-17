#!/usr/bin/env node
/**
 * test-reconcile-rulers.cjs
 *
 * Fixtures for reconcile-rulers.cjs. The gate asserts that each store-census
 * ruler (failure-composition, permission-friction, compaction) reconciles to an
 * INDEPENDENT SQLite-JSON1 oracle over the same store. These fixtures pin:
 *   - the pure comparison (equal -> ok, a single/multiple drift -> mismatch);
 *   - each oracle's exact count on a hand-built temp store (the SQL is the spec);
 *   - the end-to-end reconcile() over a real temp store: every ruler `ok` when
 *     its headline matches, `mismatch` when a drifted headline is injected,
 *     `skip`/`ruler-error` on the sibling contracts, and `oracle-error` when the
 *     store lacks the table the oracle needs;
 *   - the exit-code contract (exitCodeFor): only `ok`/`skip` exit 0; a mismatch,
 *     a ruler-error, an oracle-error, or a store error exit 1;
 *   - the CLI: a missing store skips (exit 0), args parse.
 * Deterministic: no live store, no clock.
 *
 * Run: node --test install/lib/test-reconcile-rulers.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const r = require('./reconcile-rulers.cjs');

// ─── temp store builder ──────────────────────────────────────────────────────

/**
 * Build a temp SQLite store from a spec of `session_message` rows and optional
 * `session_v2` rows. Rows are `{ id, session, type, data, seq, t }`.
 */
function makeDb({ messages = [], sessions = [], withV2 = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  const p = path.join(dir, 'oc.db');
  const D = require('node:sqlite');
  const db = new D.DatabaseSync(p);
  db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)');
  const ins = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)');
  messages.forEach((m, i) => ins.run(m.id ?? String(i), m.session, m.type, m.seq ?? i, m.t ?? 1000, m.data));
  if (withV2) {
    db.exec('CREATE TABLE session_v2 (id TEXT, idle_outcome TEXT)');
    const insS = db.prepare('INSERT INTO session_v2 VALUES (?,?)');
    for (const s of sessions) insS.run(s.id, s.outcome ?? null);
  }
  db.close();
  return p;
}

const assistant = (content) => JSON.stringify({ content });
const idle      = (outcome) => JSON.stringify({ outcome });
const errTool   = { type: 'tool', name: 'bash', state: { status: 'error', error: { type: 'permission.rejected', message: 'Permission denied: shell' } } };
const okTool    = { type: 'tool', name: 'read', state: { status: 'completed' } };

function cleanup(p) { fs.rmSync(path.dirname(p), { recursive: true, force: true }); }

// ─── pure comparison ─────────────────────────────────────────────────────────

test('compareHeadline: equal headlines reconcile; a drift names the metric', () => {
  assert.deepEqual(r.compareHeadline({ a: 1, b: 2 }, { a: 1, b: 2 }), { ok: true, mismatches: [] });
  const one = r.compareHeadline({ a: 1, b: 9 }, { a: 1, b: 2 });
  assert.equal(one.ok, false);
  assert.deepEqual(one.mismatches, [{ metric: 'b', ruler: 9, oracle: 2 }]);
  const two = r.compareHeadline({ a: 0, b: 9 }, { a: 1, b: 2 });
  assert.equal(two.mismatches.length, 2);
  // Only keys present in the oracle are compared (the oracle defines the spec).
  assert.equal(r.compareHeadline({ a: 1, extra: 5 }, { a: 1 }).ok, true);
});

// ─── oracles on a hand-built store (the SQL is the spec) ─────────────────────

test('oracleFriction: counts denial units and distinct sessions structurally', () => {
  const p = makeDb({ messages: [
    { session: 's1', type: 'assistant', data: assistant([errTool, errTool]) }, // 2 denials, 1 session
    { session: 's2', type: 'assistant', data: assistant([okTool]) },            // 0
    { session: 's3', type: 'assistant', data: assistant([errTool]) },           // 1, 1 session
  ]});
  const db = new (require('node:sqlite').DatabaseSync)(p, { readOnly: true });
  assert.deepEqual(r.oracleFriction(db, null), { denials: 3, sessions: 2 });
  db.close(); cleanup(p);
});

test('oracleFriction: a message merely mentioning permission is not a denial', () => {
  const p = makeDb({ messages: [
    { session: 's1', type: 'assistant', data: assistant([
      { type: 'text', text: 'the word permission.rejected appears in prose' },
      { type: 'tool', name: 'bash', state: { status: 'completed', output: 'Permission denied: nope' } },
    ]) },
  ]});
  const db = new (require('node:sqlite').DatabaseSync)(p, { readOnly: true });
  assert.deepEqual(r.oracleFriction(db, null), { denials: 0, sessions: 0 });
  db.close(); cleanup(p);
});

test('oracleCompaction: counts compaction rows and distinct sessions', () => {
  const p = makeDb({ messages: [
    { session: 's1', type: 'compaction', data: '{}' },
    { session: 's1', type: 'compaction', data: '{}' },
    { session: 's2', type: 'compaction', data: '{}' },
    { session: 's2', type: 'assistant', data: assistant([okTool]) },
  ]});
  const db = new (require('node:sqlite').DatabaseSync)(p, { readOnly: true });
  assert.deepEqual(r.oracleCompaction(db, null), { rows: 3, sessions: 2 });
  db.close(); cleanup(p);
});

test('oracleFailure: outcome is authoritative; recovered and unknown-with-error split correctly', () => {
  const p = makeDb({
    messages: [
      // s1: succeeded with an error unit -> recovered, not a failure.
      { session: 's1', type: 'assistant', data: assistant([errTool]), seq: 1 },
      { session: 's1', type: 'idle', data: idle('succeeded'), seq: 2 },
      // s2: succeeded, clean -> neither.
      { session: 's2', type: 'assistant', data: assistant([okTool]), seq: 1 },
      { session: 's2', type: 'idle', data: idle('succeeded'), seq: 2 },
      // s3: unknown outcome (no idle row, no session_v2) with an error -> failure via fallback.
      { session: 's3', type: 'assistant', data: assistant([errTool]), seq: 1 },
      // s4: failed outcome, no units -> failure.
      { session: 's4', type: 'idle', data: idle('failed'), seq: 1 },
    ],
    sessions: [],
  });
  const db = new (require('node:sqlite').DatabaseSync)(p, { readOnly: true });
  assert.deepEqual(r.oracleFailure(db, null), { failures: 2, recovered: 1 });
  db.close(); cleanup(p);
});

test('oracleFailure: the latest idle row (by seq) wins', () => {
  const p = makeDb({ messages: [
    { session: 's1', type: 'idle', data: idle('failed'), seq: 1 },
    { session: 's1', type: 'idle', data: idle('succeeded'), seq: 5 }, // latest wins
    { session: 's1', type: 'assistant', data: assistant([errTool]), seq: 2 },
  ]});
  const db = new (require('node:sqlite').DatabaseSync)(p, { readOnly: true });
  assert.deepEqual(r.oracleFailure(db, null), { failures: 0, recovered: 1 });
  db.close(); cleanup(p);
});

test('oracleFailure: an idle-row seq tie breaks deterministically by insertion (rowid)', () => {
  // Two idle rows share seq 3; the later-inserted row (higher rowid) must win,
  // so the tie is not left to the query planner. The succeeded row is inserted
  // second, so the outcome is succeeded -> recovered, not a failure.
  const p = makeDb({ messages: [
    { session: 's1', type: 'idle', data: idle('failed'), seq: 3 },
    { session: 's1', type: 'idle', data: idle('succeeded'), seq: 3 },
    { session: 's1', type: 'assistant', data: assistant([errTool]), seq: 2 },
  ]});
  const db = new (require('node:sqlite').DatabaseSync)(p, { readOnly: true });
  assert.deepEqual(r.oracleFailure(db, null), { failures: 0, recovered: 1 });
  db.close(); cleanup(p);
});

test('oracleFailure: session_v2.idle_outcome is the fallback when no idle row exists', () => {
  const p = makeDb({
    messages: [{ session: 's1', type: 'assistant', data: assistant([errTool]), seq: 1 }],
    sessions: [{ id: 's1', outcome: 'succeeded' }], // no idle row -> v2 supplies the outcome
  });
  const db = new (require('node:sqlite').DatabaseSync)(p, { readOnly: true });
  assert.deepEqual(r.oracleFailure(db, null), { failures: 0, recovered: 1 });
  db.close(); cleanup(p);
});

test('oracleFailure: unsupported store (no session_message) is reported, not thrown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  const p = path.join(dir, 'oc.db');
  const D = require('node:sqlite');
  const db = new D.DatabaseSync(p);
  db.exec('CREATE TABLE other (id TEXT)');
  db.close();
  const ro = new D.DatabaseSync(p, { readOnly: true });
  assert.deepEqual(r.oracleFailure(ro, null), { unsupported: 'no session_message table' });
  ro.close(); cleanup(p);
});

// ─── reconcile() end to end over a real temp store ───────────────────────────

test('reconcile: every shipped ruler reconciles to its oracle on a shared store', () => {
  // A store shaped to produce matching headlines for all three rulers.
  const p = makeDb({
    messages: [
      { session: 's1', type: 'assistant', data: assistant([errTool]), seq: 1 },
      { session: 's1', type: 'idle', data: idle('succeeded'), seq: 2 },   // recovered
      { session: 's2', type: 'assistant', data: assistant([errTool]), seq: 1 },
      { session: 's2', type: 'idle', data: idle('failed'), seq: 2 },      // process failure
      { session: 's3', type: 'compaction', data: '{}', seq: 1 },
    ],
    sessions: [],
  });
  const res = r.reconcile({ dbPath: p, since: null });
  assert.equal(res.error, null);
  assert.equal(res.skipped, null);
  const byName = Object.fromEntries(res.rows.map((x) => [x.name, x]));
  assert.equal(byName['failure-composition'].status, 'ok');
  assert.deepEqual(byName['failure-composition'].ruler, { failures: 1, recovered: 1 });
  assert.equal(byName['permission-friction'].status, 'ok');
  assert.deepEqual(byName['permission-friction'].ruler, { denials: 2, sessions: 2 });
  assert.equal(byName['compaction'].status, 'ok');
  assert.deepEqual(byName['compaction'].ruler, { rows: 1, sessions: 1 });
  cleanup(p);
});

test('reconcile: an injected drifted headline is caught as a mismatch (teeth)', () => {
  const p = makeDb({ messages: [
    { session: 's1', type: 'compaction', data: '{}' },
  ]});
  // A ruler entry whose headline lies about the count: the oracle says 1.
  const drifted = [{
    name: 'compaction',
    module: () => ({ measure: () => ({ rows: 2, sessions: 1 }) }),
    headline: (x) => ({ rows: x.rows, sessions: x.sessions }),
    oracle: r.oracleCompaction,
  }];
  const res = r.reconcile({ dbPath: p, since: null, entries: drifted });
  assert.equal(res.rows[0].status, 'mismatch');
  assert.deepEqual(res.rows[0].mismatches, [{ metric: 'rows', ruler: 2, oracle: 1 }]);
  cleanup(p);
});

test('reconcile: a ruler read error and a ruler skip are classified, not mismatches', () => {
  const p = makeDb({ messages: [{ session: 's1', type: 'compaction', data: '{}' }] });
  const entries = [
    { name: 'err',   module: () => ({ measure: () => ({ error: 'boom' }) }),            headline: () => ({}), oracle: r.oracleCompaction },
    { name: 'skip',  module: () => ({ measure: () => ({ skipped: 'no store' }) }),       headline: () => ({}), oracle: r.oracleCompaction },
  ];
  const res = r.reconcile({ dbPath: p, since: null, entries });
  assert.equal(res.rows[0].status, 'ruler-error');
  assert.equal(res.rows[0].reason, 'boom');
  assert.equal(res.rows[1].status, 'skip');
  assert.equal(res.rows[1].reason, 'no store');
  cleanup(p);
});

test('reconcile: an absent store is a skip, not an error', () => {
  const res = r.reconcile({ dbPath: path.join(os.tmpdir(), 'reconcile-absent-' + Date.now()), since: null });
  assert.match(res.skipped, /no store at/);
  assert.equal(res.error, null);
});

// ─── exit-code contract ──────────────────────────────────────────────────────

test('exitCodeFor: only ok/skip exit 0; mismatch and error statuses exit 1', () => {
  // ok and skip are benign.
  assert.equal(r.exitCodeFor({ rows: [{ status: 'ok' }, { status: 'skip' }], error: null }), 0);
  // A mismatch is drift -> 1.
  assert.equal(r.exitCodeFor({ rows: [{ status: 'mismatch' }], error: null }), 1);
  // A ruler that stopped being readable must fail the gate, not pass it green.
  assert.equal(r.exitCodeFor({ rows: [{ status: 'ruler-error' }], error: null }), 1);
  assert.equal(r.exitCodeFor({ rows: [{ status: 'oracle-error' }], error: null }), 1);
  // A store-level error -> 1.
  assert.equal(r.exitCodeFor({ rows: [], error: 'cannot open store' }), 1);
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test('parseArgs: rejects bad --db/--since, --all overrides --since, default bounded', () => {
  assert.match(r.parseArgs(['--db']).error, /--db requires/);
  assert.match(r.parseArgs(['--since', 'not-a-date']).error, /invalid --since/);
  assert.equal(r.parseArgs(['--all']).since, null);
  assert.equal(r.parseArgs(['--all', '--since', '2026-09-11T00:00:00Z']).since, null, '--all overrides --since');
  assert.ok(r.parseArgs([]).since < Date.now(), 'default window is bounded');
});

test('main: a missing store skips and exits 0', () => {
  assert.equal(r.main(['--db', path.join(os.tmpdir(), 'reconcile-absent-' + Date.now())]), 0);
});

test('main: a store-level error exits 1', () => {
  // An unreadable store (a directory, not a file) -> reconcile reports error -> 1.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  assert.equal(r.main(['--db', dir]), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('main: a per-ruler error on a readable store exits 1 (the P1 regression guard)', () => {
  // A readable store the failure ruler rejects (an unparseable row) drives a
  // real `ruler-error` through main; it must exit 1, not pass green. This is the
  // fixture that regresses if `main` stops returning `exitCodeFor(result)`.
  const p = makeDb({ messages: [
    { session: 's1', type: 'assistant', data: 'not-json', t: Date.now() },
  ]});
  assert.equal(r.reconcile({ dbPath: p }).rows[0].status, 'ruler-error');
  assert.equal(r.main(['--db', p]), 1);
  cleanup(p);
});
