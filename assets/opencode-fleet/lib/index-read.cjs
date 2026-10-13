#!/usr/bin/env node
/**
 * index-read.cjs
 *
 * The pre-commit hook validates the *staged* content everywhere except the
 * structural validators (Layer 3 `validate-skills.cjs`, Layer 4
 * `validate-agents.cjs`, Layer 12 `validate-lessons.cjs`), which read the
 * *working tree*. In the normal flow the two agree, but when a path is staged
 * and then edited again before commit, the hook's other layers and these
 * validators disagree about what is being committed — the worktree-vs-index
 * divergence recorded as an n=16 P2.
 *
 * This module is a drop-in `fs` reader for the four calls the validators make
 * (`existsSync`, `readFileSync`, `readdirSync`, `statSync`). When
 * `OPENCODE_VALIDATE_INDEX=1` (the hook sets it for the structural layers) the
 * reads come from the git index (`git show :path`, `git ls-files`) so the
 * validator sees exactly what the commit will contain; otherwise they delegate
 * to `fs` unchanged. The hook's secret scan already reads `git show :path`, so
 * this makes the whole hook consistent about "the commit, not the desk".
 *
 * The repo root is resolved from `OPENCODE_VALIDATE_ROOT` (tests) or
 * `git rev-parse --show-toplevel` at the cwd, so the reader is exercisable
 * against a temp repo. A path outside the repo falls back to `fs`.
 *
 * Read-only; no writes, no network.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs   = require('node:fs');
const path = require('node:path');

const INDEX_MODE = process.env.OPENCODE_VALIDATE_INDEX === '1';

let cachedRoot;
/** The enclosing git work tree, or the module's repo, if git is unavailable. */
function gitRoot() {
  if (cachedRoot !== undefined) return cachedRoot;
  const start = process.env.OPENCODE_VALIDATE_ROOT || process.cwd();
  try {
    cachedRoot = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    cachedRoot = path.resolve(__dirname, '..', '..');
  }
  return cachedRoot;
}

/** Repo-relative slash path for an absolute path, or null when outside the repo. */
function relPath(p) {
  const rel = path.relative(gitRoot(), path.resolve(String(p)));
  // `..foo` is a legitimate in-repo name; only `..` or a leading `../` escapes.
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Throws on a git failure (a real error is not "empty"); a query for an
// untracked path succeeds with empty output, which callers read as absent.
// `-z` keeps paths literal: without it git C-quotes non-ASCII names, which
// would omit them from the enumeration (a silent skip).
function gitLsFiles(rel) {
  const out = execFileSync('git', ['-C', gitRoot(), 'ls-files', '-z', '--', rel], { encoding: 'utf8' });
  return out.length > 0 ? out.replace(/\0$/, '').split('\0') : [];
}

/** `fs.readFileSync` for a tracked path (index) or any path (fs). */
function readFileSync(p, encoding) {
  if (!INDEX_MODE) return fs.readFileSync(p, encoding);
  const rel = relPath(p);
  if (rel === null) return fs.readFileSync(p, encoding);
  return execFileSync('git', ['-C', gitRoot(), 'show', `:${rel}`], { encoding: encoding || 'utf8' });
}

/** `fs.existsSync` for a tracked path (index) or any path (fs). */
function existsSync(p) {
  if (!INDEX_MODE) return fs.existsSync(p);
  const rel = relPath(p);
  if (rel === null) return fs.existsSync(p);
  try {
    // Quiet query: an untracked path yields no lines (and no stderr).
    return gitLsFiles(rel).length > 0;
  } catch {
    // No usable index at all; fall back to the worktree rather than claim absence.
    return fs.existsSync(p);
  }
}

/** `fs.readdirSync` names for a tracked dir (index, first path segment) or fs. */
function readdirSync(dir) {
  if (!INDEX_MODE) return fs.readdirSync(dir);
  const rel = relPath(dir);
  if (rel === null) return fs.readdirSync(dir);
  // A git failure throws here: returning [] would read as a clean empty tree,
  // a silent pass. An absent/untracked dir succeeds with empty, which is correct.
  const prefix = `${rel}/`;
  const names = new Set();
  for (const line of gitLsFiles(rel)) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    const slash = rest.indexOf('/');
    names.add(slash === -1 ? rest : rest.slice(0, slash));
  }
  return [...names];
}

/**
 * `fs.statSync`, shape-compatible with the `.isFile()`/`.isDirectory()` calls
 * the validators make. In index mode a path is a "file" if the index lists it
 * exactly, and a "directory" if the index has entries beneath it.
 */
function statSync(p) {
  if (!INDEX_MODE) return fs.statSync(p);
  const rel = relPath(p);
  if (rel === null) return fs.statSync(p);
  const lines = gitLsFiles(rel);
  const isFile = lines.includes(rel);
  const isDir = lines.some((l) => l.startsWith(`${rel}/`));
  return { isFile: () => isFile, isDirectory: () => isDir, isSymbolicLink: () => false };
}

module.exports = {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
};
