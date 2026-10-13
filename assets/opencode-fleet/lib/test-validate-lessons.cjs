#!/usr/bin/env node
/**
 * test-validate-lessons.cjs — fixtures for validate-lessons.cjs
 *
 * The gate is only as good as its teeth, so each check is exercised on both a
 * passing and a failing input: a fixture that asserts a pass must pair with one
 * that asserts the same check fails its boundary (the n=11 lesson: a verifier
 * that passes everything proves nothing).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const v = require('./validate-lessons.cjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-gate-'));
}
function write(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
}
function registry(text) {
  const p = path.join(tmp(), 'lessons.md');
  fs.writeFileSync(p, text);
  return p;
}

const GOOD = '- L006 — A single fact checked before it is remembered. (evidence: this session — PR #29; `install/lib/validate-lessons.cjs`)\n';
const GOOD_NAME = '2026-10-03T09-00-00Z-a-single-fact.md';

test('valid file + registered id -> clean', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const reg = registry('- L006 — A single fact checked before it is remembered. (evidence: this session — PR #29)\n');
  const r = v.validateLessons(dir, reg);
  assert.deepEqual(r.errors, []);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].id, 'L006');
});

test('filename must be UTC-stamped slug', () => {
  const dir = tmp();
  write(dir, 'a-single-fact.md', GOOD);
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /filename is not UTC-stamped/.test(e)));
});

test('file must be a single bullet', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD + '- L007 — a second bullet. (evidence: this session — xxxxxxxx)\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n- L007 — y (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /single bullet; found 2/.test(e)));
});

test('bullet must start with "- "', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, 'L006 — no leading dash. (evidence: this session — xxxxxxxx)\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /must start with "- "/.test(e)));
});

test('missing id is rejected', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, '- A single fact with no id. (evidence: this session — xxxxxxxx)\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /missing lesson id/.test(e)));
});

test('unregistered id is rejected', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const reg = registry('- L001 — only one (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /L006 is not registered/.test(e)));
});

test('missing evidence is rejected', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, '- L006 — a claim with no citation.\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /missing "\(evidence: \.\.\.\)" citation/.test(e)));
});

test('empty/too-short evidence is rejected', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, '- L006 — a claim with a hollow citation. (evidence: x)\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /too short/.test(e)));
});

test('duplicate id across files is rejected', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  write(dir, '2026-10-03T09-05-00Z-another.md', GOOD);
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /duplicate id L006/.test(e)));
});

test('duplicate registry id is rejected', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n- L006 — y (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /duplicate registry id L006/.test(e)));
});

test('registry-only id (no file) is grandfathered', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const reg = registry('- L001 — old inline lesson (evidence: this session — xxxxxxxx)\n- L006 — new (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.deepEqual(r.errors, []);
  assert.equal(r.registryIds, 2);
});

// ─── Append-only registry vs HEAD (n=31) ─────────────────────────────────────

test('checkAppendOnly: a pure append passes', () => {
  const head = '- L001 — a\n- L002 — b\n';
  assert.deepEqual(v.checkAppendOnly(head, head + '- L003 — c\n'), []);
});

test('checkAppendOnly: an unchanged file passes', () => {
  const head = '- L001 — a\n- L002 — b\n';
  assert.deepEqual(v.checkAppendOnly(head, head), []);
});

test('checkAppendOnly: rewriting an existing bullet fails', () => {
  const head = '- L001 — original\n- L002 — b\n';
  const staged = '- L001 — rewritten\n- L002 — b\n';
  const errs = v.checkAppendOnly(head, staged);
  assert.equal(errs.length, 1);
  assert.ok(/bullet 1 diverges/.test(errs[0]));
  assert.ok(errs[0].includes('rewritten'));
});

test('checkAppendOnly: deleting an existing bullet fails', () => {
  const head = '- L001 — a\n- L002 — b\n';
  const errs = v.checkAppendOnly(head, '- L001 — a\n');
  assert.equal(errs.length, 1);
  assert.ok(/not append-only/.test(errs[0]));
});

test('checkAppendOnly: reordering bullets fails', () => {
  const head = '- L001 — a\n- L002 — b\n';
  const errs = v.checkAppendOnly(head, '- L002 — b\n- L001 — a\n');
  assert.equal(errs.length, 1);
});

test('checkAppendOnly: editing prose around the bullets passes', () => {
  // The header legitimately changes as the gate is documented; only the
  // bullet sequence is append-only.
  const head = '# Title\n\n- L001 — a\n\n## Section\n- L002 — b\n';
  const staged = '# Title (edited)\n\nNew prose.\n\n- L001 — a\n\n## Section\n- L002 — b\n- L003 — c\n';
  assert.deepEqual(v.checkAppendOnly(head, staged), []);
});

test('checkAppendOnly: a null baseline skips (no false violation)', () => {
  assert.deepEqual(v.checkAppendOnly(null, 'anything\n'), []);
  assert.deepEqual(v.checkAppendOnly(undefined, 'anything\n'), []);
});

test('validateLessons: a rewritten registry vs HEAD is reported', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const reg = registry('- L006 — rewritten (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg, { headRegistryText: '- L006 — original (evidence: this session — xxxxxxxx)\n' });
  assert.ok(r.errors.some((e) => /not append-only/.test(e)));
});

test('validateLessons: an appended registry vs HEAD is clean', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const regression = '- L006 — x (evidence: this session — xxxxxxxx)';
  const reg = registry(`${regression}\n`);
  const r = v.validateLessons(dir, reg, { headRegistryText: regression });
  assert.deepEqual(r.errors, []);
});

test('unreadable registry fails closed', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const r = v.validateLessons(dir, path.join(tmp(), 'nope.md'));
  assert.ok(r.error && /registry not readable/.test(r.error));
});

test('unreadable lessons dir fails closed', () => {
  const dir = path.join(tmp(), 'nope');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.error && /lessons dir not readable/.test(r.error));
});

test('empty file is rejected (zero bullets)', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, '\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /single bullet; found 0/.test(e)));
});

test('id without the em-dash separator is rejected', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, '- L006 no dash separator. (evidence: this session — xxxxxxxx)\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /missing lesson id/.test(e)));
});

test('two-digit id is rejected (requires 3+)', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, '- L06 — too short. (evidence: this session — xxxxxxxx)\n');
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.ok(r.errors.some((e) => /missing lesson id/.test(e)));
});

test('registry id without the em-dash separator is not counted', () => {
  const dir = tmp();
  // The file id uses the em-dash; the registry line does not, so the id is
  // absent from the registry set and the file is reported unregistered.
  write(dir, GOOD_NAME, GOOD);
  const reg = registry('- L006 no dash (evidence: this session — xxxxxxxx)\n');
  const r = v.validateLessons(dir, reg);
  assert.equal(r.registryIds, 0);
  assert.ok(r.errors.some((e) => /L006 is not registered/.test(e)));
});

test('parseArgs defaults, flags, and errors', () => {
  const d = v.parseArgs([]);
  assert.ok(d.dir.endsWith('docs/agents/lessons'));
  assert.ok(d.registry.endsWith('docs/agents/lessons.md'));
  const f = v.parseArgs(['--dir', '/tmp/x', '--registry', '/tmp/y.md', '--json']);
  assert.equal(f.dir, '/tmp/x');
  assert.equal(f.registry, '/tmp/y.md');
  assert.equal(f.json, true);
  assert.ok(v.parseArgs(['--dir']).error);
  assert.ok(v.parseArgs(['--bogus']).error);
});

test('main exit codes: 0 clean, 1 violations, 2 usage', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  const reg = registry('- L006 — x (evidence: this session — xxxxxxxx)\n');
  assert.equal(v.main(['--dir', dir, '--registry', reg]), 0);
  write(dir, GOOD_NAME, '- no id here. (evidence: this session — xxxxxxxx)\n');
  assert.equal(v.main(['--dir', dir, '--registry', reg]), 1);
  assert.equal(v.main(['--bogus']), 2);
});

test('main fails closed on an unreadable registry', () => {
  const dir = tmp();
  write(dir, GOOD_NAME, GOOD);
  assert.equal(v.main(['--dir', dir, '--registry', path.join(tmp(), 'nope.md')]), 1);
});

// ─── headRegistryText: the git baseline is read from the cwd repo ────────────

test('headRegistryText fails closed when HEAD cannot be resolved', () => {
  const { execFileSync } = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-nohead-'));
  const saved = process.env.OPENCODE_VALIDATE_ROOT;
  try {
    execFileSync('git', ['-C', repo, 'init', '-q']);
    // Create a commit, then point HEAD at a non-existent ref so it cannot
    // resolve while history is non-empty (a broken HEAD, not an unborn one).
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    fs.mkdirSync(path.join(repo, 'docs', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/does-not-exist\n');
    const registryPath = path.join(repo, 'docs', 'agents', 'lessons.md');
    process.env.OPENCODE_VALIDATE_ROOT = repo;
    assert.throws(() => v.headRegistryText(registryPath), /cannot resolve HEAD/);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_VALIDATE_ROOT;
    else process.env.OPENCODE_VALIDATE_ROOT = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('headRegistryText skips (null) on an unborn HEAD (no commits yet)', () => {
  const { execFileSync } = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-unborn-'));
  const saved = process.env.OPENCODE_VALIDATE_ROOT;
  try {
    execFileSync('git', ['-C', repo, 'init', '-q']);
    fs.mkdirSync(path.join(repo, 'docs', 'agents'), { recursive: true });
    process.env.OPENCODE_VALIDATE_ROOT = repo;
    assert.equal(v.headRegistryText(path.join(repo, 'docs', 'agents', 'lessons.md')), null);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_VALIDATE_ROOT;
    else process.env.OPENCODE_VALIDATE_ROOT = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('headRegistryText skips (null), not throws, outside a git repo', () => {
  const saved = process.env.OPENCODE_VALIDATE_ROOT;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-norepo-'));
  try {
    process.env.OPENCODE_VALIDATE_ROOT = outside;
    assert.equal(v.headRegistryText(path.join(outside, 'lessons.md')), null);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_VALIDATE_ROOT;
    else process.env.OPENCODE_VALIDATE_ROOT = saved;
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('headRegistryText reads HEAD:docs/agents/lessons.md from OPENCODE_VALIDATE_ROOT', () => {
  const { execFileSync } = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-head-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const saved = process.env.OPENCODE_VALIDATE_ROOT;
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(repo, 'docs', 'agents'), { recursive: true });
    const registryPath = path.join(repo, 'docs', 'agents', 'lessons.md');
    fs.writeFileSync(registryPath, '- L001 — committed\n');
    git('add', '-A');
    git('commit', '-qm', 'base');

    process.env.OPENCODE_VALIDATE_ROOT = repo;
    // The module caches its root; a fresh require is not possible, so assert
    // through the exported function with the env set at call time (repoRoot
    // reads the env on first call and caches — ensure it is still unset here).
    const head = v.headRegistryText(registryPath);
    assert.equal(head, '- L001 — committed\n', 'HEAD baseline is the committed registry');

    // A staged append is accepted; a rewrite is rejected.
    const dir = path.join(repo, 'docs', 'agents', 'lessons');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, GOOD_NAME), GOOD);
    fs.writeFileSync(registryPath, '- L001 — committed\n- L006 — x (evidence: this session — xxxxxxxx)\n');
    assert.equal(v.main(['--dir', dir, '--registry', registryPath]), 0, 'append is clean');

    fs.writeFileSync(registryPath, '- L001 — REWRITTEN\n- L006 — x (evidence: this session — xxxxxxxx)\n');
    assert.equal(v.main(['--dir', dir, '--registry', registryPath]), 1, 'rewrite is rejected');
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_VALIDATE_ROOT;
    else process.env.OPENCODE_VALIDATE_ROOT = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
