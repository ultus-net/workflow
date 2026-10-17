#!/usr/bin/env node
/**
 * test-measure-failure-composition.cjs
 *
 * Fixtures for measure-failure-composition.cjs (2610.11655). Pins the
 * classifier against hand-computed synthetic session evidence and real temp
 * SQLite stores: permission/step-budget/error-loop are process, a delivered
 * but poor result is content, first-signal precedence is deterministic, and an
 * absent store is a graceful skip.
 *
 * Run: node --test install/lib/test-measure-failure-composition.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const m = require('./measure-failure-composition.cjs');

const toolPart = (name, state) => ({ type: 'tool', name, state });
const textPart = (text) => ({ type: 'text', text });
const msg = (content) => JSON.stringify({ content });
const sid = 'ses_x';

// ─── pure helpers ────────────────────────────────────────────────────────────

test('safeJson: returns null on malformed, parses valid', () => {
  assert.equal(m.safeJson('{not json'), null);
  assert.deepEqual(m.safeJson('{"a":1}'), { a: 1 });
});

test('normalizeToolPart: keeps tool parts, keeps the error text', () => {
  const p = m.normalizeToolPart(toolPart('bash', { status: 'error', error: { type: 'permission.rejected', message: 'PermissionDenied: x' } }));
  assert.equal(p.status, 'error');
  assert.equal(p.errorType, 'permission.rejected');
  assert.match(p.text, /PermissionDenied/);
  assert.equal(m.normalizeToolPart({ type: 'text', text: 'hi' }), null);
  assert.equal(m.normalizeToolPart(null), null);
});

test('unitsFromSessionMessage: tool parts plus text parts', () => {
  const units = m.unitsFromSessionMessage(msg([
    { type: 'reasoning', text: 'x' },
    toolPart('bash', { status: 'error', error: { message: 'boom' } }),
    { type: 'text', text: 'done' },
  ]));
  assert.equal(units.length, 3); // reasoning text, tool, text
  assert.equal(units[1].kind, 'tool');
  assert.deepEqual(m.unitsFromSessionMessage('{bad'), []);
  assert.deepEqual(m.unitsFromSessionMessage(JSON.stringify({ content: 'nope' })), []);
});

test('unitsFromLegacyPart: the row data is itself a part', () => {
  assert.equal(m.unitsFromLegacyPart(JSON.stringify(toolPart('bash', { status: 'error', error: { message: 'x' } }))).length, 1);
  assert.equal(m.unitsFromLegacyPart(JSON.stringify(textPart('notice'))).length, 1);
  assert.deepEqual(m.unitsFromLegacyPart('not json'), []);
});

test('outcomeFromIdleData: reads outcome or status', () => {
  assert.equal(m.outcomeFromIdleData(JSON.stringify({ outcome: 'failed' })), 'failed');
  assert.equal(m.outcomeFromIdleData(JSON.stringify({ status: 'interrupted' })), 'interrupted');
  assert.equal(m.outcomeFromIdleData('{}'), null);
});

// ─── classify (hand-computed) ────────────────────────────────────────────────

test('classify: a permission denial is a process failure', () => {
  const s = { id: 's1', outcome: 'failed', units: [
    { kind: 'tool', tool: 'bash', status: 'error', errorType: 'permission.rejected', text: 'PermissionDenied: write blocked', t: 10 },
  ] };
  assert.deepEqual(m.classifySession(s), { cls: 'process', signal: 'permission' });
});

test('classify: step-budget exhaustion is a process failure', () => {
  const s = { id: 's1', outcome: 'failed', units: [
    { kind: 'text', tool: 'text', status: null, errorType: null, text: 'You have reached the maximum number of steps.', t: 10 },
  ] };
  assert.deepEqual(m.classifySession(s), { cls: 'process', signal: 'step-budget' });
});

test('classify: an error loop is a process failure at the Nth identical message', () => {
  const s = { id: 's1', outcome: 'failed', units: [
    { kind: 'tool', tool: 'read', status: 'error', errorType: 'tool.execution', text: 'ENOENT: no such file', t: 1 },
    { kind: 'tool', tool: 'read', status: 'error', errorType: 'tool.execution', text: 'ENOENT: no such file', t: 2 },
    { kind: 'tool', tool: 'read', status: 'error', errorType: 'tool.execution', text: 'ENOENT: no such file', t: 3 },
  ] };
  assert.deepEqual(m.classifySession(s), { cls: 'process', signal: 'error-loop' });
});

test('classify: two identical errors do not make a loop', () => {
  const s = { id: 's1', outcome: 'failed', units: [
    { kind: 'tool', tool: 'read', status: 'error', errorType: 'tool.execution', text: 'ENOENT', t: 1 },
    { kind: 'tool', tool: 'read', status: 'error', errorType: 'tool.execution', text: 'ENOENT', t: 2 },
  ] };
  assert.deepEqual(m.classifySession(s), { cls: 'content', signal: 'content' });
});

test('classify: a delivered but poor result with no process signal is content', () => {
  const s = { id: 's1', outcome: 'failed', units: [
    { kind: 'text', tool: 'text', status: null, errorType: null, text: 'Here is the plan: ...', t: 1 },
  ] };
  assert.deepEqual(m.classifySession(s), { cls: 'content', signal: 'content' });
});

test('classify: first-signal precedence — process wins over content', () => {
  const s = { id: 's1', outcome: 'failed', units: [
    { kind: 'text', tool: 'text', status: null, errorType: null, text: 'a poor delivered plan', t: 1 },
    { kind: 'tool', tool: 'bash', status: 'error', errorType: 'permission.rejected', text: 'blocked', t: 5 },
  ] };
  assert.equal(m.classifySession(s).cls, 'process');
});

test('isFailureSession: outcome is authoritative; error units are the fallback', () => {
  assert.equal(m.isFailureSession({ id: 's', outcome: 'failed', units: [] }), true);
  assert.equal(m.isFailureSession({ id: 's', outcome: 'interrupted', units: [] }), true);
  assert.equal(m.isFailureSession({ id: 's', outcome: null, units: [{ status: 'error' }] }), true);
  assert.equal(m.isFailureSession({ id: 's', outcome: 'succeeded', units: [{ status: 'completed' }] }), false);
});

test('isFailureSession: a succeeded session with error units recovered, not a failure', () => {
  const recovered = { id: 's', outcome: 'succeeded', units: [
    { kind: 'tool', tool: 'bash', status: 'error', errorType: 'permission.rejected', text: 'blocked', t: 1 },
  ] };
  assert.equal(m.isFailureSession(recovered), false, 'succeeded outcome wins over error units');
  assert.equal(m.isRecoveredSession(recovered), true);
  // An outcome-unknown session with the same error units stays a failure (the fallback).
  assert.equal(m.isFailureSession({ ...recovered, outcome: null }), true);
  assert.equal(m.isRecoveredSession({ ...recovered, outcome: null }), false);
  // A succeeded session with no error units is neither a failure nor recovered.
  assert.equal(m.isFailureSession({ id: 's', outcome: 'succeeded', units: [{ status: 'completed' }] }), false);
  assert.equal(m.isRecoveredSession({ id: 's', outcome: 'succeeded', units: [{ status: 'completed' }] }), false);
});

// ─── analyze ─────────────────────────────────────────────────────────────────

test('analyze: splits process vs content and counts signals', () => {
  const sessions = [
    { id: 'p1', outcome: 'failed', units: [{ kind: 'tool', status: 'error', errorType: 'permission.rejected', text: 'blocked', t: 1 }] },
    { id: 'p2', outcome: null, units: [{ kind: 'tool', status: 'error', errorType: 'tool.execution', text: 'x', t: 1 }, { kind: 'tool', status: 'error', errorType: 'tool.execution', text: 'x', t: 2 }, { kind: 'tool', status: 'error', errorType: 'tool.execution', text: 'x', t: 3 }] },
    { id: 'c1', outcome: 'failed', units: [{ kind: 'text', status: null, text: 'poor plan', t: 1 }] },
    { id: 'ok1', outcome: 'succeeded', units: [{ kind: 'tool', status: 'completed', text: 'ok', t: 1 }] },
  ];
  const a = m.analyze(sessions);
  assert.equal(a.failures, 3);
  assert.equal(a.process, 2);
  assert.equal(a.content, 1);
  assert.equal(a.recovered, 0);
  assert.equal(a.bySignal.permission, 1);
  assert.equal(a.bySignal['error-loop'], 1);
  assert.equal(a.processRate, 2 / 3);
  assert.deepEqual(a.representatives.process.sort(), ['p1', 'p2']);
  assert.deepEqual(a.representatives.content, ['c1']);
});

test('analyze: a succeeded-with-error session is recovered, excluded from the failure split', () => {
  const sessions = [
    { id: 'p1', outcome: 'failed', units: [{ kind: 'tool', status: 'error', errorType: 'permission.rejected', text: 'blocked', t: 1 }] },
    { id: 'rec1', outcome: 'succeeded', units: [{ kind: 'tool', status: 'error', errorType: 'permission.rejected', text: 'blocked', t: 2 }] },
    { id: 'rec2', outcome: 'succeeded', units: [{ kind: 'text', status: null, text: 'poor plan', t: 3 }] },
    { id: 'ok1', outcome: 'succeeded', units: [{ kind: 'tool', status: 'completed', text: 'ok', t: 4 }] },
  ];
  const a = m.analyze(sessions);
  assert.equal(a.failures, 1, 'only the failed-outcome session is a failure');
  assert.equal(a.process, 1);
  assert.equal(a.content, 0);
  assert.equal(a.recovered, 1, 'one succeeded-with-error session');
  assert.equal(a.processRate, 1);
  assert.deepEqual(a.representatives.process, ['p1']);
});

test('analyze: zero failures yields zero rates, not NaN', () => {
  const a = m.analyze([{ id: 'ok', outcome: 'succeeded', units: [] }]);
  assert.equal(a.failures, 0);
  assert.equal(a.processRate, 0);
  assert.equal(a.contentRate, 0);
});

test('analyze: representative lists are capped', () => {
  const sessions = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, outcome: 'failed', units: [{ kind: 'text', status: null, text: 'poor', t: 1 }],
  }));
  const a = m.analyze(sessions, 3);
  assert.equal(a.content, 20);
  assert.equal(a.representatives.content.length, 3);
});

// ─── readSessions (real temp SQLite) ─────────────────────────────────────────

function makeDb(build) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failcomp-'));
  const p = path.join(dir, 'oc.db');
  const D = require('node:sqlite');
  const db = new D.DatabaseSync(p);
  build(db);
  db.close();
  return p;
}

test('readSessions: missing store is a skip, not an error', () => {
  const r = m.readSessions(path.join(os.tmpdir(), 'failcomp-absent-' + Date.now()), null);
  assert.match(r.skipped, /no store at/);
  assert.equal(r.error, null);
});

test('readSessions: reads assistant rows, idle outcome, and session_v2', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', msg([
      toolPart('bash', { status: 'error', error: { type: 'permission.rejected', message: 'PermissionDenied: blocked' } }),
    ]), 1000);
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('2', 's1', 'idle', JSON.stringify({ outcome: 'failed' }), 1001);
    db.exec('CREATE TABLE session_v2 (id TEXT, idle_outcome TEXT)');
    db.prepare('INSERT INTO session_v2 VALUES (?,?)').run('s2', 'failed');
  });
  const r = m.readSessions(p, null);
  assert.equal(r.error, null);
  const byId = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
  assert.ok(byId.s1, 's1 assembled from assistant + idle rows');
  assert.equal(byId.s1.outcome, 'failed');
  assert.deepEqual(m.classifySession(byId.s1), { cls: 'process', signal: 'permission' });
  assert.equal(byId.s2.outcome, 'failed', 'session_v2 outcome read');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readSessions: falls back to the legacy part table', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE part (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('1', 's1', JSON.stringify(textPart('You have reached the maximum number of steps.')), 1000);
  });
  const r = m.readSessions(p, null);
  assert.equal(r.error, null);
  assert.equal(r.sessions.length, 1);
  assert.equal(m.classifySession(r.sessions[0]).signal, 'step-budget');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readSessions: session_v2 shape drift degrades gracefully (no error)', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', msg([toolPart('read', { status: 'error', error: { message: 'x' } })]), 1000);
    db.exec('CREATE TABLE session_v2 (id TEXT)'); // no idle_outcome column
  });
  const r = m.readSessions(p, null);
  assert.equal(r.error, null);
  assert.equal(r.sessions.length, 1);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readSessions: any unparseable row is format drift (error)', () => {
  const p = makeDb((db) => {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', msg([textPart('ok')]), 900);
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('2', 's1', 'assistant', '{bad json', 1000);
  });
  const r = m.readSessions(p, null);
  assert.match(r.error, /unparseable/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('measure: skip and error propagate; success spreads analyze', () => {
  assert.match(m.measure({ dbPath: path.join(os.tmpdir(), 'failcomp-none-' + Date.now()) }).skipped, /no store at/);
  const p = makeDb((db) => {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)');
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?)').run('1', 's1', 'assistant', msg([
      toolPart('bash', { status: 'error', error: { type: 'permission.rejected', message: 'blocked' } }),
    ]), 1000);
  });
  const res = m.measure({ dbPath: p });
  assert.equal(res.error, null);
  assert.equal(res.failures, 1);
  assert.equal(res.process, 1);
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
  assert.equal(m.main(['--db', path.join(os.tmpdir(), 'failcomp-absent-' + Date.now())]), 0);
});
