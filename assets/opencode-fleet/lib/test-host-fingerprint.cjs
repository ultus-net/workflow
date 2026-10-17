#!/usr/bin/env node
/**
 * test-host-fingerprint.cjs
 *
 * Fixture tests for host-fingerprint.cjs. The checker turns the n=12 ruler's
 * prose host pin into a machine-checkable digest + marker contract, so the
 * fixtures must pin the skip-vs-drift split: absent host skips, present host
 * with a changed digest/marker/missing file drifts, and a matching host passes.
 *
 * Run: node --test install/lib/test-host-fingerprint.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('./host-fingerprint.cjs');

/** Build a temp host tree whose file matches an entry's digest + markers. */
function hostWith(entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfp-'));
  const full = path.join(dir, entry.path);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return { dir, full };
}

/**
 * Build a temp host tree with a matching file for every pinned entry, so the
 * all-match path is exercised against the real pin list regardless of its
 * length (n=34 added a second pin). `contents` maps an entry path to its bytes.
 */
function hostWithAll(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfp-'));
  for (const entry of h.HOST_FILES) {
    const full = path.join(dir, entry.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents[entry.path]);
  }
  return dir;
}

test('verifyHost: an unset source is a SKIP, not a failure', () => {
  const r = h.verifyHost(null);
  assert.equal(r.status, 'skip');
  assert.match(r.reason, /no host source/);
});

test('verifyHost: a non-existent source is a SKIP', () => {
  const r = h.verifyHost(path.join(os.tmpdir(), 'hostfp-absent-' + Date.now()));
  assert.equal(r.status, 'skip');
  assert.match(r.reason, /not present/);
});

test('main: a skip exits 0', () => {
  const rc = h.main(['--src', path.join(os.tmpdir(), 'hostfp-nope-' + Date.now())]);
  assert.equal(rc, 0);
});

test('checkFile: a matching file passes (digest + markers)', () => {
  const content = 'export const MAX_LINES = 2_000\n';
  const { dir, full } = hostWith({ path: 'packages/core/src/tool-output-store.ts' });
  fs.writeFileSync(full, content);
  const entry = { path: 'packages/core/src/tool-output-store.ts', sha256: h.sha256(Buffer.from(content, 'utf8')), markers: ['export const MAX_LINES = 2_000'] };
  const r = h.checkFile(dir, entry);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sha256, entry.sha256);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkFile: a changed digest is DRIFT', () => {
  const { dir, full } = hostWith({ path: 'a/b.ts' });
  fs.writeFileSync(full, 'changed content');
  const entry = { path: 'a/b.ts', sha256: h.sha256(Buffer.from('original content', 'utf8')), markers: [] };
  const r = h.checkFile(dir, entry);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'digest');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkFile: a missing file is DRIFT (not a skip)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfp-'));
  const r = h.checkFile(dir, { path: 'gone.ts', sha256: 'x', markers: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkFile: a matching digest with a gone marker is DRIFT (marker guards a stale pin)', () => {
  const content = 'no marker here';
  const { dir, full } = hostWith({ path: 'a/b.ts' });
  fs.writeFileSync(full, content);
  const entry = { path: 'a/b.ts', sha256: h.sha256(Buffer.from(content, 'utf8')), markers: ['const preview = ('] };
  const r = h.checkFile(dir, entry);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'markers');
  assert.deepEqual(r.missingMarkers, ['const preview = (']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verifyHost: all-match is ok; any divergence is drift', () => {
  const content = 'export const MAX_LINES = 2_000\n';
  const saved = h.HOST_FILES.map((e) => ({ ref: e, path: e.path, sha256: e.sha256, markers: [...e.markers] }));
  try {
    // Pin every entry to the same synthetic content so the tree is buildable.
    for (const e of h.HOST_FILES) {
      e.sha256 = h.sha256(Buffer.from(content, 'utf8'));
      e.markers = ['export const MAX_LINES = 2_000'];
    }
    const contents = {};
    for (const e of h.HOST_FILES) contents[e.path] = content;
    const dir = hostWithAll(contents);
    const ok = h.verifyHost(dir);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.checked, h.HOST_FILES.length);
    // Diverge exactly one pinned file (the last), so drift is detected even with
    // multiple pins and regardless of which one changes.
    const target = path.join(dir, h.HOST_FILES[h.HOST_FILES.length - 1].path);
    fs.writeFileSync(target, content + '// host changed\n');
    const drift = h.verifyHost(dir);
    assert.equal(drift.status, 'drift');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    for (const s of saved) { s.ref.path = s.path; s.ref.sha256 = s.sha256; s.ref.markers = s.markers; }
  }
});

test('main: drift exits 1 (with --json)', () => {
  const content = 'export const MAX_LINES = 2_000\n';
  const real = h.HOST_FILES[0];
  const orig = { ...real, markers: [...real.markers] };
  const origLog = console.log;
  try {
    real.sha256 = h.sha256(Buffer.from(content, 'utf8'));
    real.markers = ['export const MAX_LINES = 2_000'];
    const { dir, full } = hostWith(real);
    fs.writeFileSync(full, content + '// drift\n');
    console.log = () => {};
    const rc = h.main(['--src', dir, '--json']);
    assert.equal(rc, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    console.log = origLog;
    Object.assign(real, orig);
  }
});

test('verifyHost: a file passed as --src is DRIFT, not a skip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfp-'));
  const f = path.join(dir, 'not-a-dir.ts');
  fs.writeFileSync(f, 'x');
  const r = h.verifyHost(f);
  assert.equal(r.status, 'drift');
  assert.equal(r.details[0].reason, 'not a directory');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emitPins: reports the digest of a real file', () => {
  const content = 'export const MAX_LINES = 2_000\n';
  const contents = {};
  for (const e of h.HOST_FILES) contents[e.path] = content;
  const dir = hostWithAll(contents);
  const pins = h.emitPins(dir);
  assert.equal(pins.length, h.HOST_FILES.length);
  for (const p of pins) assert.equal(p.sha256, h.sha256(Buffer.from(content, 'utf8')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseArgs: --src with no value is a usage error', () => {
  assert.match(h.parseArgs(['--src']).error, /--src requires/);
  assert.match(h.parseArgs(['--bogus']).error, /unknown argument/);
});

test('verifyHost: an emptied pin list is DRIFT, not a vacuous OK', () => {
  // Mutate in place so the module-internal reference sees it (HOST_FILES is a
  // module-const array, not re-read from the export binding).
  const orig = h.HOST_FILES.slice();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfp-'));
  try {
    h.HOST_FILES.length = 0;
    const r = h.verifyHost(dir);
    assert.equal(r.status, 'drift');
    assert.match(r.details[0].reason, /no pinned files/);
  } finally {
    h.HOST_FILES.length = 0;
    h.HOST_FILES.push(...orig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --emit with an absent source exits 1 (no throw)', () => {
  const origErr = console.error;
  try {
    console.error = () => {};
    const rc = h.main(['--emit', '--src', path.join(os.tmpdir(), 'hostfp-emit-nope-' + Date.now())]);
    assert.equal(rc, 1);
  } finally {
    console.error = origErr;
  }
});

test('main: --emit with a missing pinned file exits 1', () => {
  const real = h.HOST_FILES[0];
  const origPath = real.path;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfp-'));
  const origErr = console.error;
  try {
    real.path = 'packages/core/src/absent.ts';
    console.error = () => {};
    const rc = h.main(['--emit', '--src', dir]);
    assert.equal(rc, 1);
  } finally {
    real.path = origPath;
    console.error = origErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --emit with a non-regular pinned file exits 1', () => {
  const real = h.HOST_FILES[0];
  const origPath = real.path;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostfp-'));
  const origErr = console.error;
  try {
    // A directory where a regular file is pinned: statSync().isFile() is false.
    fs.mkdirSync(path.join(dir, real.path), { recursive: true });
    console.error = () => {};
    const rc = h.main(['--emit', '--src', dir]);
    assert.equal(rc, 1);
  } finally {
    real.path = origPath;
    console.error = origErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
