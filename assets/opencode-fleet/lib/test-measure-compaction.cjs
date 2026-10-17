#!/usr/bin/env node
/**
 * test-measure-compaction.cjs
 *
 * Fixtures for measure-compaction.cjs. Pins the ruler against hand-computed
 * synthetic store JSON and real temp SQLite stores: the row parse (including
 * the two schema vintages), the fail-loud contract on a malformed row, the
 * reason/status/agent splits, the per-session thrash distribution, the
 * summarizer-usage quantiles, and the skip-on-absent-store path. The critical
 * fixture is `tokens.input is reported as summarizer usage, not trigger
 * context`: it pins the mislabeling the ruler's header warns about.
 *
 * Run: node --test install/lib/test-measure-compaction.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const m = require('./measure-compaction.cjs');

// A base-vintage row (no model/cost/tokens) and a usage-vintage row.
const baseRow  = (over = {}) => JSON.stringify({ time: { created: 1000 }, status: 'completed', reason: 'auto', summary: 's', recent: 'r', ...over });
const usageRow = (tokens, over = {}) => JSON.stringify({ time: { created: 2000 }, status: 'completed', reason: 'auto', summary: 's', recent: 'r', model: { id: 'syn:auto', providerID: 'synthetic' }, cost: 0.01, tokens, ...over });

// ─── pure helpers ────────────────────────────────────────────────────────────

test('safeJson: returns null on malformed, parses valid', () => {
  assert.equal(m.safeJson('{not json'), null);
  assert.deepEqual(m.safeJson('{"a":1}'), { a: 1 });
});

test('compactionFromRow: base vintage has no usage, keeps status/reason', () => {
  const c = m.compactionFromRow(baseRow());
  assert.equal(c.status, 'completed');
  assert.equal(c.reason, 'auto');
  assert.equal(c.hasUsage, false);
  assert.equal(c.usage, null);
  assert.equal(c.model, null);
  assert.equal(c.hasRecent, true);
  assert.equal(m.compactionFromRow('{bad'), null, 'a malformed row is null, never a partial object');
});

test('compactionFromRow: a non-object is null (fail-loud signal)', () => {
  assert.equal(m.compactionFromRow('{bad json'), null);
  assert.equal(m.compactionFromRow('[]'), null);
  assert.equal(m.compactionFromRow('"str"'), null);
  assert.equal(m.compactionFromRow('null'), null);
});

test('compactionFromRow: usage vintage carries model/cost/tokens', () => {
  const c = m.compactionFromRow(usageRow({ input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 9 } }));
  assert.equal(c.hasUsage, true);
  assert.equal(c.model, 'syn:auto');
  assert.equal(c.cost, 0.01);
  assert.equal(c.usage.input, 5);
  assert.equal(c.usage.cache.write, 9);
});

test('compactionFromRow: an empty recent is not counted (hasRecent false)', () => {
  assert.equal(m.compactionFromRow(baseRow({ recent: '' })).hasRecent, false);
});

test('quantile: interpolates, sorts a copy, null on empty', () => {
  assert.equal(m.quantile([], 0.5), null);
  assert.equal(m.quantile([7], 0.9), 7);
  assert.equal(m.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(m.quantile([4, 1, 3, 2], 0.5), 2.5);
  const src = [3, 1, 2];
  m.quantile(src, 0.5);
  assert.deepEqual(src, [3, 1, 2], 'input array is not mutated');
  assert.equal(m.quantile([1, 2, 3], 0), 1);
  assert.equal(m.quantile([1, 2, 3], 1), 3);
});

// ─── summarize (hand-computed) ───────────────────────────────────────────────

const R = (over) => ({ status: 'completed', reason: 'auto', hasUsage: false, usage: null, model: null, cost: null, summaryLen: 1, recentLen: 0, hasRecent: false, t: 1, session: 's', agent: 'build', ...over });

test('summarize: reason and status splits', () => {
  const s = m.summarize([
    R({ reason: 'auto' }), R({ reason: 'auto' }), R({ reason: 'manual' }),
    R({ reason: 'auto', status: 'failed' }),
  ]);
  assert.equal(s.rows, 4);
  assert.deepEqual(s.byReason, { auto: 3, manual: 1 });
  assert.deepEqual(s.byStatus, { completed: 3, failed: 1 });
});

test('summarize: schema vintage split and usage rate', () => {
  const s = m.summarize([
    R({}), R({}),
    R({ hasUsage: true, usage: { input: 10 }, model: 'syn:auto' }),
  ]);
  assert.equal(s.withUsage, 1);
  assert.equal(s.usageRate, 1 / 3);
  assert.deepEqual(s.usageByModel, { 'syn:auto': 1 });
});

test('summarize: tokens.input is reported as summarizer usage, not trigger context', () => {
  // The real-world mislabeling: input=3 with a huge cache.write. The ruler
  // must report input as-is (summarizer usage) and never infer a trigger size.
  const s = m.summarize([R({ hasUsage: true, usage: { input: 3, cache: { read: 0, write: 490364 } } })]);
  assert.equal(s.usageTokenQuantiles.p50, 3);
  assert.equal(s.usageMaxInput, 3);
  assert.ok(!('triggerTokens' in s), 'no trigger-context field is fabricated');
});

test('summarize: agent split, unknown when absent', () => {
  const s = m.summarize([
    R({ agent: 'build' }), R({ agent: 'build' }), R({ agent: 'explore' }), R({ agent: null }),
  ]);
  assert.deepEqual(s.byAgent, { build: 2, explore: 1, unknown: 1 });
});

test('summarize: thrash distribution and quantiles', () => {
  const rows = [];
  // session a: 1, b: 3, c: 6, d: 12 -> buckets once 1, 2-4 1, 5-9 1, 10+ 1
  for (const [sid, n] of [['a', 1], ['b', 3], ['c', 6], ['d', 12]]) {
    for (let i = 0; i < n; i++) rows.push(R({ session: sid }));
  }
  const s = m.summarize(rows);
  assert.equal(s.sessions, 4);
  assert.equal(s.thrash.max, 12);
  assert.deepEqual(s.thrash.buckets, { one: 1, twoToFour: 1, fiveToNine: 1, tenPlus: 1 });
  assert.equal(s.thrash.median, 4.5);
});

test('summarize: the thrash bucket boundaries (4/5 and 9/10) are pinned', () => {
  // Sessions with counts exactly on the edges. An off-by-one (`< 4` vs `<= 4`,
  // or `< 10` vs `<= 9`) would move 4, 5, 9, or 10 and fail here.
  const rows = [];
  for (const [sid, n] of [['a', 1], ['b', 2], ['c', 4], ['d', 5], ['e', 9], ['f', 10]]) {
    for (let i = 0; i < n; i++) rows.push(R({ session: sid }));
  }
  const s = m.summarize(rows);
  assert.equal(s.sessions, 6);
  assert.deepEqual(s.thrash.buckets, { one: 1, twoToFour: 2, fiveToNine: 2, tenPlus: 1 },
    'count 1 -> one; 2 and 4 -> twoToFour; 5 and 9 -> fiveToNine; 10 -> tenPlus');
});

test('summarize: recent coverage and char quantiles; empty input is null-safe', () => {
  const s = m.summarize([R({ hasRecent: true, recentLen: 100 }), R({ hasRecent: false, recentLen: 0 })]);
  assert.equal(s.withRecent, 1);
  assert.equal(s.recentRate, 0.5);
  assert.equal(s.recentCharQuantiles.p50, 100);
  const empty = m.summarize([]);
  assert.equal(empty.rows, 0);
  assert.equal(empty.usageRate, 0);
  assert.equal(empty.thrash.max, 0);
  assert.equal(empty.usageTokenQuantiles, null);
});

// ─── readCompactions (real temp SQLite) ──────────────────────────────────────

function makeDb(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-'));
  const p = path.join(dir, 'oc.db');
  const D = require('node:sqlite');
  const db = new D.DatabaseSync(p);
  build(db);
  db.close();
  return p;
}

const MSG = 'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)';
const insMsg = (db) => db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)');
const SESS = 'CREATE TABLE session_v2 (id TEXT, agent TEXT)';
const insSess = (db) => db.prepare('INSERT INTO session_v2 VALUES (?,?)');

test('readCompactions: missing store is a skip, not an error', () => {
  const r = m.readCompactions(path.join(os.tmpdir(), 'compaction-absent-' + Date.now()), null);
  assert.match(r.skipped, /no store at/);
  assert.equal(r.error, null);
});

test('readCompactions: reads compaction rows and joins the agent', () => {
  const p = makeDb((db) => {
    db.exec(MSG); db.exec(SESS);
    insSess(db).run('s1', 'build');
    insMsg(db).run('1', 's1', 'compaction', baseRow(), 1000);
    insMsg(db).run('2', 's1', 'compaction', usageRow({ input: 42, output: 1 }), 2000);
    insMsg(db).run('3', 's1', 'assistant', JSON.stringify({ content: [] }), 1500); // ignored
  });
  const r = m.readCompactions(p, null);
  assert.equal(r.error, null);
  assert.equal(r.compactions.length, 2, 'only compaction rows are read');
  assert.equal(r.compactions[0].agent, 'build');
  const s = m.summarize(r.compactions);
  assert.equal(s.withUsage, 1);
  assert.equal(s.usageMaxInput, 42);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readCompactions: a malformed compaction row is format drift (error)', () => {
  const p = makeDb((db) => {
    db.exec(MSG);
    insMsg(db).run('1', 's1', 'compaction', baseRow(), 900);
    insMsg(db).run('2', 's1', 'compaction', '{bad json', 1000);
  });
  const r = m.readCompactions(p, null);
  assert.match(r.error, /unparseable/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readCompactions: a missing session table degrades agent to unknown (no error)', () => {
  const p = makeDb((db) => {
    db.exec(MSG);
    insMsg(db).run('1', 's1', 'compaction', baseRow(), 1000);
  });
  const r = m.readCompactions(p, null);
  assert.equal(r.error, null);
  assert.equal(r.compactions[0].agent, 'unknown');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readCompactions: since filters by time_created (the empty window)', () => {
  const p = makeDb((db) => {
    db.exec(MSG);
    insMsg(db).run('1', 's1', 'compaction', baseRow({ time: { created: 1000 } }), 1000);
    insMsg(db).run('2', 's1', 'compaction', baseRow({ time: { created: 5000 } }), 5000);
  });
  const r = m.readCompactions(p, 3000);
  assert.equal(r.compactions.length, 1);
  assert.equal(r.compactions[0].t, 5000, 'the surviving row is the later one, so the filter — not a shared time — is asserted');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('measure: skip and error propagate; success spreads summarize', () => {
  assert.match(m.measure({ dbPath: path.join(os.tmpdir(), 'compaction-none-' + Date.now()) }).skipped, /no store at/);
  const p = makeDb((db) => {
    db.exec(MSG);
    insMsg(db).run('1', 's1', 'compaction', baseRow(), 1000);
    insMsg(db).run('2', 's1', 'compaction', baseRow({ reason: 'manual' }), 2000);
  });
  const res = m.measure({ dbPath: p });
  assert.equal(res.error, null);
  assert.equal(res.rows, 2);
  assert.deepEqual(res.byReason, { auto: 1, manual: 1 });
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
  assert.equal(m.main(['--db', path.join(os.tmpdir(), 'compaction-absent-' + Date.now())]), 0);
});
