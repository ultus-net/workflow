#!/usr/bin/env node
/**
 * test-index-read.cjs
 *
 * Fixtures for index-read.cjs, the reader that makes the structural validators
 * (Layer 3 validate-skills, Layer 4 validate-agents, Layer 12
 * validate-lessons) read the *staged* content instead of the working tree,
 * closing the n=16 worktree-vs-index P2.
 *
 * The load-bearing claim is that index mode reads the commit, not the desk: a
 * temp git repo stages one content, rewrites the working tree to another, and
 * the reader must return the staged (index) content. Each test spawns the
 * reader in a child process with the env flag set (the module caches its mode
 * at require time), so the fixtures prove the real entry point, not a stub.
 *
 * Run: node --test install/lib/test-index-read.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const READER = path.join(__dirname, 'index-read.cjs');

/** Run a snippet that requires the reader under a repo + mode. */
function inRepo(repo, mode, body) {
  const script = `const fs = require(${JSON.stringify(READER)});\n${body}`;
  return execFileSync('node', ['-e', script], {
    cwd: repo,
    env: {
      ...process.env,
      OPENCODE_VALIDATE_ROOT: repo,
      ...(mode === 'index' ? { OPENCODE_VALIDATE_INDEX: '1' } : { OPENCODE_VALIDATE_INDEX: '0' }),
    },
    encoding: 'utf8',
  });
}

/** A temp git repo with a committed base so the index exists. */
function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'indexread-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-qm', 'base');
  return { repo, git };
}

test('index mode reads the staged content, not the working tree', () => {
  const { repo, git } = tempRepo();
  fs.writeFileSync(path.join(repo, 'file.txt'), 'STAGED\n');
  git('add', 'file.txt');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'WORKTREE\n'); // edit after staging
  const fromIndex = inRepo(repo, 'index', "process.stdout.write(fs.readFileSync('file.txt', 'utf8'));");
  const fromWorktree = inRepo(repo, 'worktree', "process.stdout.write(fs.readFileSync('file.txt', 'utf8'));");
  assert.equal(fromIndex, 'STAGED\n');
  assert.equal(fromWorktree, 'WORKTREE\n');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('index mode: a staged-but-deleted file is absent from the index', () => {
  const { repo, git } = tempRepo();
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\n');
  git('add', 'gone.txt');
  git('commit', '-qm', 'add');
  fs.rmSync(path.join(repo, 'gone.txt'));
  git('add', '-A');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'resurrected in the worktree\n');
  const existsIndex = inRepo(repo, 'index', "process.stdout.write(String(fs.existsSync('gone.txt')));");
  const existsWorktree = inRepo(repo, 'worktree', "process.stdout.write(String(fs.existsSync('gone.txt')));");
  assert.equal(existsIndex, 'false', 'a deletion staged cannot be resurrected by the worktree');
  assert.equal(existsWorktree, 'true');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('index mode readdir/stat agree with the index tree', () => {
  const { repo, git } = tempRepo();
  fs.mkdirSync(path.join(repo, 'dir'));
  fs.writeFileSync(path.join(repo, 'dir/a.md'), 'a\n');
  fs.writeFileSync(path.join(repo, 'dir/b.md'), 'b\n');
  git('add', '-A');
  git('commit', '-qm', 'dir');
  // Stage a new file and delete one, all after the commit.
  fs.writeFileSync(path.join(repo, 'dir/c.md'), 'c\n');
  git('add', 'dir/c.md');
  fs.rmSync(path.join(repo, 'dir/b.md'));
  git('add', '-A');
  const body = [
    "const names = fs.readdirSync('dir').sort().join(',');",
    "const aFile = fs.statSync('dir/a.md').isFile();",
    "const dirDir = fs.statSync('dir').isDirectory();",
    "process.stdout.write(names + '|' + aFile + '|' + dirDir);",
  ].join('\n');
  assert.equal(inRepo(repo, 'index', body), 'a.md,c.md|true|true');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('index mode: an untracked path is absent, a path outside the repo falls back to fs', () => {
  const { repo } = tempRepo();
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n');
  const untracked = inRepo(repo, 'index', "process.stdout.write(String(fs.existsSync('untracked.txt')));");
  assert.equal(untracked, 'false', 'an untracked file is not part of the commit');
  const outsideFile = path.join(os.tmpdir(), `indexread-outside-${Date.now()}.txt`);
  fs.writeFileSync(outsideFile, 'outside\n');
  const outside = inRepo(repo, 'index', `process.stdout.write(String(fs.existsSync(${JSON.stringify(outsideFile)})));`);
  assert.equal(outside, 'true', 'a path outside the repo falls back to fs');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outsideFile, { force: true });
});

test('index mode: a tracked ".."-prefixed name reads the index (not a worktree fallback)', () => {
  // `..foo.md` is a legitimate in-repo name; classifying it as outside-repo
  // would silently serve worktree bytes for a tracked path (a false-clean).
  const { repo, git } = tempRepo();
  fs.writeFileSync(path.join(repo, '..foo.md'), 'STAGED\n');
  git('add', '..foo.md');
  fs.writeFileSync(path.join(repo, '..foo.md'), 'WORKTREE\n');
  const fromIndex = inRepo(repo, 'index', "process.stdout.write(fs.readFileSync('..foo.md', 'utf8'));");
  assert.equal(fromIndex, 'STAGED\n');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('index mode: a non-ASCII tracked name is enumerated (no C-quoting skip)', () => {
  // `git ls-files` C-quotes non-ASCII names by default; `-z` keeps them literal
  // so a trackable non-ASCII file is not silently dropped from the enumeration.
  const { repo, git } = tempRepo();
  fs.mkdirSync(path.join(repo, 'dir'));
  fs.writeFileSync(path.join(repo, 'dir/caf\u00e9.md'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'accent');
  const body = "process.stdout.write(fs.readdirSync('dir').join(','));";
  assert.equal(inRepo(repo, 'index', body), 'caf\u00e9.md');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('index mode: statSync distinguishes a file from a directory', () => {
  const { repo, git } = tempRepo();
  fs.mkdirSync(path.join(repo, 'dir'));
  fs.writeFileSync(path.join(repo, 'dir/a.md'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'd');
  const body = [
    "const d = fs.statSync('dir');",
    "const f = fs.statSync('dir/a.md');",
    "process.stdout.write(d.isFile() + '|' + d.isDirectory() + '|' + f.isFile() + '|' + f.isDirectory());",
  ].join('\n');
  assert.equal(inRepo(repo, 'index', body), 'false|true|true|false');
  fs.rmSync(repo, { recursive: true, force: true });
});
