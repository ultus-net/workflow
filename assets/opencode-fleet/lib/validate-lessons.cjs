#!/usr/bin/env node
/**
 * validate-lessons.cjs
 *
 * A read-only admission gate for the agent lesson memory. The playbook
 * (docs/agents/rsi-loop-playbook.md, mechanism 4) requires itemized lessons with
 * an id, an evidence citation, and one bullet, admitted *before* they enter the
 * file — because accumulation is non-monotonic and a defective lesson
 * contaminates later ones irreversibly (2608.05810). This gate is the mechanical
 * half of that: it enforces the *shape* and the id/registry linkage. The
 * semantic half — "does the cited evidence actually support the claim?" — is an
 * external review, not a regex, and stays human/reviewer-owned.
 *
 * What it checks (fail-closed):
 *   1. every `docs/agents/lessons/*.md` is a `YYYY-MM-DDTHH-MM-SSZ-<slug>.md`
 *      (a UTC-timestamped, single-topic filename);
 *   2. the file is ONE bullet: exactly one line whose first non-space char is
 *      `- `, and no additional non-blank lines;
 *   3. the bullet carries an id `- L<nnn> — ` and an `(evidence: ...)` citation
 *      with non-empty content;
 *   4. ids are unique across lesson files and do not collide with the registry;
 *   5. every lesson-file id is registered in `docs/agents/lessons.md`.
 *      (Registry-only entries with no file, e.g. the older inline L001–L005, are
 *      grandfathered; the rule is one-directional: every *file* must be listed.)
 *   6. the registry is append-only against HEAD: the ordered sequence of
 *      id-bearing bullet lines in the committed registry must be an in-order
 *      prefix of the staged sequence. A rewrite, renumber, reorder, deletion, or
 *      mid-file insertion of a bullet is a violation (the file header's "Append
 *      only" rule). Edits to the file's prose header are allowed. n=31 owed
 *      this: `/retro` now writes the registry on trust, and the shape gate above
 *      cannot see an edit to an existing bullet.
 *
 * It never writes. Exit codes: 0 = clean, 1 = violations, 2 = usage error.
 *
 * Usage:
 *   node install/lib/validate-lessons.cjs [--dir DIR] [--registry FILE] [--json]
 */

'use strict';

// Reads the staged content under OPENCODE_VALIDATE_INDEX=1 (pre-commit), so the
// admission gate validates the commit, not the working tree.
const fs   = require('./index-read.cjs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const ID_RE       = /^- (L\d{3,}) — /m;          // "- L006 — ..." (em-dash separator)
const REG_ID_RE   = /^- (L\d{3,}) — /;           // registry index line
const FILE_RE     = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-.+\.md$/;
const EVIDENCE_RE = /\(evidence:\s*(\S[^)]*?)\s*\)/;

/**
 * Append-only predicate (pure). The registry's rule is "never rewrite,
 * renumber, or delete existing *bullets*", so the check compares the ordered
 * sequence of id-bearing bullet lines, not raw bytes: the committed bullet
 * sequence must be an in-order prefix of the staged sequence. That catches a
 * rewrite, renumber, reorder, deletion, or mid-file insertion of a bullet while
 * still allowing edits to the file's prose header (which documents the gate and
 * legitimately changes). `headText == null` skips (no baseline). Returns an
 * array of error strings.
 */
const BULLET_RE = /^- L\d{3,} — /;
function bulletLines(text) {
  return text.split('\n').filter((l) => BULLET_RE.test(l));
}
function checkAppendOnly(headText, stagedText) {
  if (headText == null || stagedText == null) return [];
  const h = bulletLines(headText);
  const s = bulletLines(stagedText);
  for (let i = 0; i < h.length; i++) {
    if (h[i] !== s[i]) {
      const clip = (v) => {
        if (v === undefined) return '<absent>';
        const t = v.length > 60 ? `${v.slice(0, 57)}...` : v;
        return JSON.stringify(t);
      };
      return [`registry is not append-only: bullet ${i + 1} diverges from HEAD (was ${clip(h[i])}, now ${clip(s[i])})`];
    }
  }
  return [];
}

/** Parse the registry file into { ids:Set, errors:[] }. */
function checkRegistry(registryText) {
  const errors = [];
  const ids = new Set();
  const lines = registryText.split('\n');
  for (const line of lines) {
    const m = REG_ID_RE.exec(line);
    if (!m) continue;
    const id = m[1];
    if (ids.has(id)) errors.push(`duplicate registry id ${id}`);
    ids.add(id);
  }
  return { ids, errors };
}

/**
 * Check one lesson file's content + name. Returns an array of error strings.
 * Pure: takes the file's basename and text, so it is fixture-testable.
 */
function checkLesson(basename, text, registryIds) {
  const errors = [];
  if (!FILE_RE.test(basename)) {
    errors.push(`filename is not UTC-stamped "<YYYY-MM-DDTHH-MM-SSZ>-<slug>.md": ${basename}`);
  }
  const lines = text.split('\n');
  const nonBlank = lines.filter((l) => l.trim() !== '');
  if (nonBlank.length !== 1) {
    errors.push(`must be a single bullet; found ${nonBlank.length} non-blank lines`);
  }
  const bullet = nonBlank[0] || '';
  if (!bullet.startsWith('- ')) {
    errors.push('bullet must start with "- "');
  }
  const idMatch = ID_RE.exec(text);
  if (!idMatch) {
    errors.push('missing lesson id: bullet must start "- L<nnn> — ..."');
  } else if (!registryIds.has(idMatch[1])) {
    errors.push(`id ${idMatch[1]} is not registered in lessons.md`);
  }
  const ev = EVIDENCE_RE.exec(text);
  if (!ev) {
    errors.push('missing "(evidence: ...)" citation');
  } else if (ev[1].replace(/[*\s]/g, '').length < 8) {
    errors.push('evidence citation is empty or too short to be a citation');
  }
  return { errors, id: idMatch ? idMatch[1] : null };
}

/** Validate a directory of lesson files against a registry file. */
function validateLessons(dir, registryPath, opts = {}) {
  let registryText;
  try {
    registryText = fs.readFileSync(registryPath, 'utf8');
  } catch {
    return { error: `registry not readable: ${registryPath}`, files: [], errors: [] };
  }
  const reg = checkRegistry(registryText);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return { error: `lessons dir not readable: ${dir}`, files: [], errors: [] };
  }

  const files = [];
  const errors = [...reg.errors];
  // Append-only against HEAD (n=31): /retro now writes the registry on trust.
  // `opts.headRegistryText === undefined` derives it from git; `null` skips
  // (fixtures pass null, or a path outside the repo resolves to null anyway).
  // A broken HEAD is an error, not a skip: fail closed.
  if (opts.headRegistryText === undefined) {
    let headText;
    try {
      headText = headRegistryText(registryPath);
    } catch (err) {
      errors.push(err.message);
      headText = null;
    }
    errors.push(...checkAppendOnly(headText, registryText));
  } else {
    errors.push(...checkAppendOnly(opts.headRegistryText, registryText));
  }
  const seenFileIds = new Map(); // id -> file
  for (const name of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      errors.push(`unreadable lesson file: ${name}`);
      continue;
    }
    const r = checkLesson(name, text, reg.ids);
    if (r.id) {
      if (seenFileIds.has(r.id)) errors.push(`duplicate id ${r.id} in ${name} and ${seenFileIds.get(r.id)}`);
      else seenFileIds.set(r.id, name);
    }
    for (const e of r.errors) errors.push(`${name}: ${e}`);
    files.push({ name, id: r.id, errors: r.errors });
  }
  return { files, errors, registryIds: reg.ids.size };
}

// ─── Repo + HEAD baseline ────────────────────────────────────────────────────

let cachedRoot;
let cachedRootKey;
/** The enclosing git work tree, or null when the start dir is not in a repo. */
function detectRepoRoot() {
  const start = process.env.OPENCODE_VALIDATE_ROOT || process.cwd();
  if (cachedRoot !== undefined && cachedRootKey === start) return cachedRoot;
  try {
    cachedRoot = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    cachedRoot = null;
  }
  cachedRootKey = start;
  return cachedRoot;
}

/** The enclosing git work tree, or the module's repo when git is unavailable. */
function repoRoot() {
  return detectRepoRoot() || path.resolve(__dirname, '..', '..');
}

/**
 * The committed registry at HEAD. Returns null only when there is a legitimate
 * reason to skip the append-only check: the path is outside the repo, the start
 * dir is not a git repo at all, HEAD is unborn (a repo with no commits yet), or
 * HEAD resolves but the registry is absent from it (a first commit). A repo
 * that has commits but whose HEAD cannot be resolved is an error, not a skip:
 * the pre-commit path always has HEAD, so a broken HEAD must fail closed rather
 * than silently disable the check. Throws in that case.
 */
function headRegistryText(registryPath) {
  const root = detectRepoRoot();
  if (root == null) return null;
  const rel = path.relative(root, path.resolve(String(registryPath)));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const ref = rel.split(path.sep).join('/');
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Distinguish an unborn HEAD (no commits yet -> legitimate skip) from a
    // broken HEAD (commits exist but HEAD will not resolve -> fail closed).
    let commits = null;
    try {
      commits = Number(execFileSync('git', ['-C', root, 'rev-list', '--count', '--all'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim());
    } catch { /* treat an unreadable history as broken */ }
    if (commits === 0) return null;
    throw new Error(`cannot resolve HEAD in ${root}; refusing to skip the registry append-only check`);
  }
  try {
    return execFileSync('git', ['-C', root, 'show', `HEAD:${ref}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // HEAD resolves; the registry is simply not in it yet
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const root = repoRoot();
  const opts = {
    dir: path.join(root, 'docs/agents/lessons'),
    registry: path.join(root, 'docs/agents/lessons.md'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { const v = argv[++i]; if (v == null) return { error: '--dir requires a directory' }; opts.dir = path.resolve(v); }
    else if (a === '--registry') { const v = argv[++i]; if (v == null) return { error: '--registry requires a file' }; opts.registry = path.resolve(v); }
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: validate-lessons.cjs [--dir DIR] [--registry FILE] [--json]');
    return 0;
  }
  const result = validateLessons(opts.dir, opts.registry);
  if (result.error) { console.error(`  \u2717  ${result.error}`); return 1; }

  if (opts.json) {
    console.log(JSON.stringify({ dir: opts.dir, registry: opts.registry, files: result.files.length, registryIds: result.registryIds, errors: result.errors }, null, 2));
    return result.errors.length === 0 ? 0 : 1;
  }

  if (result.errors.length === 0) {
    console.log(`  \u2713  lesson admission gate \u2014 ${result.files.length} file(s), ${result.registryIds} registry id(s), 0 error(s)`);
    return 0;
  }
  console.log(`  \u2717  lesson admission gate \u2014 ${result.errors.length} error(s):`);
  for (const e of result.errors) console.log(`      - ${e}`);
  return 1;
}

module.exports = {
  ID_RE, FILE_RE, EVIDENCE_RE,
  checkRegistry, checkLesson, checkAppendOnly, validateLessons,
  repoRoot, detectRepoRoot, headRegistryText, parseArgs, main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
