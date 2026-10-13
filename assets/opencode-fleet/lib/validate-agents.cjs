#!/usr/bin/env node
/**
 * validate-agents.cjs
 *
 * Validates the OpenCode agent fleet in install/opencode/agents/. The golden
 * tree install/opencode/ is the single deploy source; the live
 * ~/.config/opencode/agents path symlinks straight into it.
 *
 * Checks (errors block CI):
 *   - every *.md has YAML frontmatter with a non-empty 'description',
 *     'mode: subagent', and an integer 'steps' >= 0
 *   - the only frontmatter external_directory item allowed is the
 *     ~/.config/opencode/style/** glob with effect: allow, written in the
 *     canonical block form (any other spelling is an error, not a skip)
 *   - an agent that grants style read to ~/.config/opencode/style/**
 *     must reference coding-style.md in its prompt
 *
 * AGENTS_DIR can be overridden by env for tests.
 *
 * Exit codes: 0 = all clear, 1 = one or more errors
 */

'use strict';

// Reads the staged content under OPENCODE_VALIDATE_INDEX=1 (pre-commit), so the
// fleet gate validates the commit, not the working tree.
const fs   = require('./index-read.cjs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const AGENTS_DIR = process.env.AGENTS_DIR ||
  path.resolve(__dirname, '..', 'opencode', 'agents');

// The style-floor reference every grant-bearing agent must contain.
const STYLE_REF = 'coding-style.md';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse YAML-style frontmatter from the top of a markdown file.
 * Returns a key→value object, or null if no frontmatter block found.
 * Values are stripped of surrounding quotes.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  if (!match) return null;

  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) result[key] = value;
  }
  return result;
}

/** Return the raw text of the leading frontmatter block, or null. */
function frontmatterBlock(content) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  return match ? match[1] : null;
}

/**
 * Normalize a scalar frontmatter value: trim, drop an inline comment, and
 * strip surrounding quotes. Applied to action/resource/effect so quoted or
 * commented YAML variants compare equal to the canonical form.
 */
function normVal(raw) {
  if (raw == null) return null;
  return raw.trim().replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Inspect the frontmatter for external_directory permissions. Fail-closed:
 * every `action: external_directory` occurrence in the frontmatter is counted,
 * and occurrences the canonical block-only scanner does not recognize are
 * reported as `unrecognized` rather than skipped. Returns { style, other,
 * occurrences, unrecognized }.
 *
 * Canonical form (block sequence, one key per line):
 *   permissions:
 *     - action: external_directory
 *       resource: "~/.config/opencode/style/**"
 *       effect: allow
 *
 * `style` is true when a canonical item grants the style-floor glob with
 * `effect: allow`. `other` lists canonical external_directory items with a
 * wrong resource or a revoked (non-allow) effect. `unrecognized` is the count
 * of external_directory actions found anywhere in the frontmatter but not
 * matched by a canonical item, so a YAML-equivalent spelling (dash-alone
 * entries, whole-line flow sequences, anchors) is an error, not a silent pass.
 */
function externalDirectoryGrants(content) {
  const block = frontmatterBlock(content);
  const result = { style: false, other: [], occurrences: 0, unrecognized: 0, suspicious: 0 };
  if (block === null) return result;

  // Fail-closed: count the value token within the permissions section,
  // regardless of how the key is spelled (`action:`, `"action":`, off-line
  // values). Every realistic `external_directory` grant contains this token;
  // YAML escapes and anchors/aliases (which can hide it) are flagged
  // suspicious below. Scoped to the permissions block so prose elsewhere in
  // the frontmatter cannot match.
  const permLines = [];
  let inPerms = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^\S/.test(line)) inPerms = /^\s*permissions\s*:/.test(line);
    if (inPerms) permLines.push(line);
  }
  for (const line of permLines) {
    const occ = line.match(/["']?external_directory["']?/g);
    if (occ) result.occurrences += occ.length;
    // A string escape anywhere in permissions is treated as hostile, since
    // it can reconstruct the token without spelling it.
    if (/\\[xuU0-9]/.test(line)) result.suspicious++;
    // Anchors (`&name`), aliases (`*name`), and merge keys (`<<:`) can inject
    // a grant that the line scanner never sees.
    if (/(^|\s)[&*][A-Za-z0-9_-]+/.test(line) || /<<\s*:/.test(line)) result.suspicious++;
  }

  // Canonical scanner: one item per line beginning with `- key: value`, with
  // continuation lines `key: value` at any deeper indent.
  let inItem = false;
  let action = null;
  let resource = null;
  let effect = null;
  const flush = () => {
    if (!inItem) return;
    if (action === 'external_directory') {
      const isStyle = resource === '~/.config/opencode/style/**';
      if (isStyle && effect === 'allow') {
        result.style = true;
      } else {
        const shown = resource === null ? '(no resource)' : resource;
        result.other.push(effect === null ? shown : `${shown} (effect: ${effect})`);
      }
    }
    inItem = false; action = null; resource = null; effect = null;
  };

  const pairRe = /^\s*-?\s*(action|resource|effect)\s*:\s*("(?:[^"]*)"|'(?:[^']*)'|[^,}\n#]+)/;

  for (const line of block.split(/\r?\n/)) {
    if (/^\s*-\s+\S/.test(line)) { flush(); inItem = true; }
    if (!inItem) continue;
    const m = line.match(pairRe);
    if (!m) continue;
    const val = normVal(m[2]);
    if (m[1] === 'action') action = val;
    else if (m[1] === 'resource') resource = val;
    else effect = val;
  }
  flush();

  if (result.occurrences !== result.other.length + (result.style ? 1 : 0)) {
    result.unrecognized = Math.max(
      0,
      result.occurrences - result.other.length - (result.style ? 1 : 0),
    );
  }
  return result;
}

// ─── Validator ───────────────────────────────────────────────────────────────

function validateAgent(name, content) {
  const errors = [];

  // ── Frontmatter ──────────────────────────────────────────────────────────
  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push('Missing or malformed YAML frontmatter (expected --- block at top of file)');
  } else {
    if (!fm.description) {
      errors.push("Frontmatter missing required non-empty field: 'description'");
    }
    if (fm.mode !== 'subagent') {
      errors.push(`Frontmatter 'mode' must be 'subagent' (got '${fm.mode || ''}')`);
    }
    if (!/^\d+$/.test(fm.steps === undefined ? '' : fm.steps)) {
      errors.push(`Frontmatter 'steps' must be a non-negative integer (got '${fm.steps || ''}')`);
    }
  }

  // ── Style grant requires a coding-style.md reference ─────────────────────
  const grant = externalDirectoryGrants(content);
  if (grant.suspicious > 0) {
    errors.push(`${grant.suspicious} YAML escape/anchor construct(s) in permissions (use the canonical block form with literal values)`);
  }
  if (grant.unrecognized > 0) {
    errors.push(`${grant.unrecognized} external_directory occurrence(s) not in the canonical block form (use one 'key: value' per line under a '- action: external_directory' item)`);
  }
  for (const resource of grant.other) {
    errors.push(`unexpected external_directory grant: ${resource} (only ~/.config/opencode/style/** with effect: allow is allowed)`);
  }
  if (grant.style && !content.includes(STYLE_REF)) {
    errors.push('grants style access but never references coding-style.md');
  }

  return errors;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`ERROR: agents directory not found at ${AGENTS_DIR}`);
    process.exit(1);
  }

  const agentFiles = fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md') && fs.statSync(path.join(AGENTS_DIR, f)).isFile())
    .sort();

  // Fail-closed on nested entries: OpenCode loads {agent,agents}/**/*.md
  // recursively, but this verifier only validates top-level files. Any
  // subdirectory is an error so a nested agent cannot bypass the checks.
  const nestedDirs = fs.readdirSync(AGENTS_DIR)
    .filter(f => fs.statSync(path.join(AGENTS_DIR, f)).isDirectory());

  let totalErrors = 0;

  for (const dir of nestedDirs) {
    totalErrors++;
    console.log(`  ✗  ${dir}/`);
    console.log('       ERROR: nested agent directory not supported (fleet is flat); move the agent to the top level');
  }

  for (const name of agentFiles) {
    const content = fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
    const errors  = validateAgent(name, content);
    totalErrors  += errors.length;

    if (errors.length === 0) {
      console.log(`  ✓  ${name}`);
    } else {
      console.log(`  ✗  ${name}`);
      for (const msg of errors) console.log(`       ERROR: ${msg}`);
    }
  }

  const status = totalErrors > 0 ? 'FAILED' : 'PASSED';
  console.log(`\n${agentFiles.length} agents checked — ${totalErrors} error(s) — ${status}`);

  if (totalErrors > 0) process.exit(1);
}

main();
