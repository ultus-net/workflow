#!/usr/bin/env node
/**
 * test-effective-model.cjs
 *
 * Fixture tests for verify-effective-model.cjs. Builds a throwaway SQLite
 * `session_v2` store and a throwaway agent directory, then asserts the verifier
 * separates known-good post-pin sessions from the pre-pin `syn:auto` reach gap,
 * tolerates OpenRouter failover rows, and degrades gracefully with no store.
 *
 * Run: node --test install/lib/test-effective-model.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const v = require('./verify-effective-model.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vem-'));
}

function writeAgents(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'executor.md'),
    '---\ndescription: cheap\nmodel: synthetic/syn:small:text\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(dir, 'reviewer.md'),
    '---\ndescription: strong\nmodel: synthetic/syn:large:text\n---\nbody\n',
  );
  // Unpinned agent: must not be graded.
  fs.writeFileSync(path.join(dir, 'loose.md'), '---\ndescription: no pin\n---\nbody\n');
}

function writeDb(dbPath, rows) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, agent TEXT, model TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER)`);
  const insert = db.prepare(
    'INSERT INTO session_v2 (id, agent, model, cost, tokens_input, tokens_output, time_created) VALUES (?,?,?,?,?,?,?)',
  );
  rows.forEach((r, i) =>
    insert.run(
      `s${i}`, r.agent, r.model, r.cost ?? 0, r.tin ?? 0, r.tout ?? 0, r.t ?? 0,
    ),
  );
  db.close();
}

const model = (providerID, id) => JSON.stringify({ providerID, id });

test('parseFrontmatter + intendedModels reads only pinned agents', () => {
  const dir = tmpdir();
  writeAgents(dir);
  const intended = v.intendedModels(dir);
  assert.ok(intended, 'dir has agents');
  assert.deepEqual(intended.executor, { providerID: 'synthetic', id: 'syn:small:text' });
  assert.deepEqual(intended.reviewer, { providerID: 'synthetic', id: 'syn:large:text' });
  assert.equal(intended.loose, undefined, 'unpinned agent is not graded');
});

test('classify separates routed, unrouted, wrong-tier, and off-provider', () => {
  const intended = { providerID: 'synthetic', id: 'syn:large:text' };
  assert.equal(v.classify({ providerID: 'synthetic', id: 'syn:large:text' }, intended), 'ok');
  assert.equal(v.classify({ providerID: 'synthetic', id: 'syn:auto' }, intended), 'unrouted');
  assert.equal(v.classify({ providerID: 'synthetic', id: 'syn:small:text' }, intended), 'wrong-tier');
  assert.equal(v.classify({ providerID: 'openrouter', id: 'openrouter/auto' }, intended), 'off-provider');
  assert.equal(v.classify(null, intended), 'unparseable', 'malformed model is drift, not failover');
});

test('post-pin window is clean; pre-pin window flags the reach gap', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  const PIN = Date.parse('2026-10-02T06:10:00Z');

  writeDb(dbPath, [
    // pre-pin: custom agents left on syn:auto → unrouted (the reach gap)
    { agent: 'reviewer', model: model('synthetic', 'syn:auto'), t: PIN - 86_400_000 },
    { agent: 'executor', model: model('synthetic', 'syn:auto'), t: PIN - 86_400_000 },
    // post-pin: routed correctly
    { agent: 'reviewer', model: model('synthetic', 'syn:large:text'), t: PIN + 1000 },
    { agent: 'executor', model: model('synthetic', 'syn:small:text'), t: PIN + 1000 },
    // legitimate OpenRouter failover must NOT count as drift
    { agent: 'reviewer', model: model('openrouter', 'openrouter/auto'), t: PIN + 2000 },
    // an unpinned agent row is ignored
    { agent: 'loose', model: model('synthetic', 'syn:auto'), t: PIN + 3000 },
  ]);

  const post = v.verify({ agentsDir, dbPath, since: PIN });
  assert.equal(post.drift, 0, 'post-pin window has no drift');
  assert.equal(post.agents.reviewer.ok, 1);
  assert.equal(post.agents.reviewer['off-provider'], 1, 'failover tolerated');
  assert.equal(post.totals.graded, 3);

  const all = v.verify({ agentsDir, dbPath });
  assert.ok(all.drift >= 2, 'pre-pin syn:auto rows count as drift');
  assert.equal(all.agents.reviewer.unrouted, 1);
  assert.equal(all.agents.executor.unrouted, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrong-tier (small where large intended) is drift', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:small:text'), t: 1 },
  ]);
  const r = v.verify({ agentsDir, dbPath });
  assert.equal(r.agents.reviewer['wrong-tier'], 1);
  assert.equal(r.drift, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a malformed model column is drift, not silently green', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: 'not-json-at-all', t: 1 },
    { agent: 'executor', model: '{}', t: 1 },
  ]);
  const r = v.verify({ agentsDir, dbPath });
  assert.equal(r.agents.reviewer.unparseable, 1);
  assert.equal(r.agents.executor.unparseable, 1, 'a JSON object with no providerID is unparseable');
  assert.equal(r.drift, 2, 'format drift must fail loud, not pass as off-provider');
  assert.equal(v.main(['--db', dbPath, '--agents', agentsDir]), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a flag missing its value is a usage error (exit 2), not a crash', () => {
  assert.equal(v.main(['--db']), 2);
  assert.equal(v.main(['--since']), 2);
  assert.equal(v.main(['--agents']), 2);
});

test('a bad --agents dir fails loud instead of silently grading nothing', () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:auto'), t: 1 },
  ]);
  // Typo'd / nonexistent agents dir.
  const r = v.verify({ agentsDir: path.join(dir, 'nope-agents'), dbPath });
  assert.match(r.error, /agents dir not readable/);
  assert.equal(r.skipped, null);
  assert.equal(v.main(['--db', dbPath, '--agents', path.join(dir, 'nope-agents')]), 1);

  // Existing dir with no pinned agents.
  const bare = path.join(dir, 'bare-agents');
  fs.mkdirSync(bare, { recursive: true });
  const empty = v.verify({ agentsDir: bare, dbPath });
  assert.match(empty.error, /no pinned agents/);
  assert.equal(v.main(['--db', dbPath, '--agents', bare]), 1);

  // Omitted agentsDir gives a clear message, not "not readable: undefined".
  const omitted = v.verify({ dbPath });
  assert.match(omitted.error, /no agents dir given/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing store and missing table degrade gracefully (skip, no drift)', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);

  const missing = v.verify({ agentsDir, dbPath: path.join(dir, 'nope.db') });
  assert.match(missing.skipped, /no store/);
  assert.equal(missing.drift, 0);

  const emptyDb = path.join(dir, 'empty.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(emptyDb); db.exec('CREATE TABLE unrelated (x)'); db.close();
  const noTable = v.verify({ agentsDir, dbPath: emptyDb });
  assert.match(noTable.skipped, /no session_v2/);
  assert.equal(noTable.drift, 0);
  assert.equal(noTable.error, null);
  assert.equal(v.main(['--db', emptyDb, '--agents', agentsDir]), 0, 'absent table is inert');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a present-but-wrong-schema session_v2 fails loud, not green', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'drifted.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  // Same table name, missing the columns the verifier reads.
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, agent TEXT)');
  db.close();

  const r = v.verify({ agentsDir, dbPath });
  assert.equal(r.skipped, null, 'a present table is not "absence"');
  assert.match(r.error, /missing column/);
  assert.equal(r.drift, 0);
  assert.equal(v.main(['--db', dbPath, '--agents', agentsDir]), 1, 'schema drift must exit non-zero');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI exits 1 on drift, 0 on a clean window', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:auto'), t: 1 },
  ]);
  const rcDrift = v.main(['--db', dbPath, '--agents', agentsDir]);
  assert.equal(rcDrift, 1);

  const db2 = path.join(dir, 'clean.db');
  writeDb(db2, [{ agent: 'reviewer', model: model('synthetic', 'syn:large:text'), t: 1 }]);
  const rcClean = v.main(['--db', db2, '--agents', agentsDir]);
  assert.equal(rcClean, 0);

  assert.equal(v.main(['--bogus']), 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
