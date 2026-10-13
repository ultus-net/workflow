#!/usr/bin/env node
/**
 * validate-config.cjs
 *
 * Validates the installer-owned opencode golden tree:
 *   - install/opencode/config.jsonc parses as JSON once // comments and
 *     trailing commas are stripped
 *   - permissions is an array (V2 shape); top-level `permission` must not exist
 *   - every top-level key is classified and every cap-bearing key's value shape
 *     matches its declared shape (config-shape.cjs)
 *   - each agent frontmatter carries its expected model tier pin
 *
 * The golden tree install/opencode/ is the single deploy source: the live
 * ~/.config/opencode/ entries symlink straight into it. There is no second
 * canonical copy to drift against, so the former overlay↔canonical parity and
 * deploy gates are gone.
 *
 * Exit codes: 0 = all clear, 1 = one or more errors
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// checkConfigShape() — declared value shape for the managed object-valued keys,
// extracted so it is fixture-pinned (test-config-shape.cjs).
const { checkConfigShape, checkShapeCoverage } = require('./config-shape.cjs');
const { checkAgentModel } = require('./agent-model-pin.cjs');

// ─── Config ──────────────────────────────────────────────────────────────────

const OVERLAY_DIR = path.resolve(__dirname, '..', 'opencode');
const CONFIG_PATH = path.join(OVERLAY_DIR, 'config.jsonc');
const AGENTS_DIR  = path.join(OVERLAY_DIR, 'agents');

// Expected per-agent tier pin. Adding an agent here is how the validator learns
// it; a missing or mismatched model: line is an error.
//
// Agents pin an established synthetic ALIAS, never a dated model id. The alias
// is the stable contract: Synthetic repoints `syn:large:text` / `syn:small:text`
// to the current large/small models, so the fleet follows the upgrade without a
// config edit. A pinned `synthetic/hf:...` id freezes the fleet to whatever the
// model was on the day it was written and silently drifts stale. The golden-n1
// pin (3b42eee) introduced exactly this; n=30 reverts it and guards it.
const EXPECTED_MODELS = {
  'executor.md':        'synthetic/syn:small:text',
  'retrospective.md':   'synthetic/syn:small:text',
  'screener.md':        'synthetic/syn:small:text',
  'executor-strong.md': 'synthetic/syn:large:text',
  'reviewer.md':        'synthetic/syn:large:text',
  'decompose.md':       'synthetic/syn:large:text',
};

// Overlay top-level key classification. Every key the overlay declares must be
// classified, so a new key cannot ship without a human deciding whether it is
// safe to deploy. `EXPECTED_MODELS` is the same pattern applied to agents. Keep
// this overlay-only: the live file is never read here (that would couple repo
// checks to machine state).
//   SHARED            — deploys verbatim from the golden tree (config, UI)
//   CONFIG_EXEMPT     — never deployed from the golden tree over the live copy
//   CONVERGE_MANAGED  — overlay-owned by value; must carry a declared shape
const SHARED           = ['$schema', 'default_agent', 'compaction', 'plugins', 'instructions', 'lsp', 'mcp'];
const CONFIG_EXEMPT    = ['permissions'];
const CONVERGE_MANAGED = ['watcher', 'tool_output'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize JSONC to JSON: strip // line comments and trailing commas that
 * are not inside double-quoted strings. The config is JSONC (the repo's
 * canonical files use comments and trailing commas), so JSON.parse cannot
 * consume it raw. Two passes: comments first, then trailing commas, so the
 * look-ahead never lands in stripped comment text.
 */
function stripJsonc(text) {
  // Pass 1 — remove // line comments (string-aware).
  let stripped = '';
  let inString = false;
  let escaped  = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      stripped += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; stripped += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    stripped += ch;
  }

  // Pass 2 — drop trailing commas before ] or } (string-aware).
  let out = '';
  inString = false;
  escaped  = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j])) j++;
      if (stripped[j] === ']' || stripped[j] === '}') continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Parse YAML-style frontmatter from the top of a markdown file.
 * Returns a key→value object, or null if no frontmatter block found.
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

/**
 * Validate the discovered agent fleet (pure, fixture-testable). `read` maps an
 * agent filename to its raw markdown. Returns `{ errors, lines }`.
 *
 * Every discovered agent must carry a valid alias-form model pin. EXPECTED_MODELS
 * adds an exact tier assertion only where the tier is a contract; a table entry
 * with no backing file is a stale contract, still an error. Neither check can
 * lean on the other: a lockstep re-pin to a dated id updates both the file and
 * the table, so the alias guard (checkAgentModel) is the standing predicate.
 */
function checkAgentFleet(discovered, read) {
  const errors = [];
  const lines = [];
  for (const name of discovered) {
    let content;
    try {
      content = read(name);
    } catch (e) {
      lines.push(`  ✗  ${name} — unreadable (${e.message})`);
      errors.push(`${name} unreadable`);
      continue;
    }
    const fm = parseFrontmatter(content);
    if (!fm) {
      lines.push(`  ✗  ${name} — missing frontmatter`);
      errors.push(`${name} missing frontmatter`);
      continue;
    }
    const aliasCheck = checkAgentModel(name, fm.model);
    if (aliasCheck.errors.length > 0) {
      lines.push(...aliasCheck.lines);
      errors.push(...aliasCheck.errors);
      continue;
    }
    const expected = EXPECTED_MODELS[name];
    if (expected && fm.model !== expected) {
      lines.push(`  ✗  ${name} — model is '${fm.model}', expected '${expected}'`);
      errors.push(`${name} model mismatch`);
      continue;
    }
    lines.push(`  ✓  ${name} — model: ${fm.model}`);
  }
  for (const name of Object.keys(EXPECTED_MODELS)) {
    if (!discovered.includes(name)) {
      lines.push(`  ✗  ${name} — not found`);
      errors.push(`${name} missing`);
    }
  }
  return { errors, lines };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const errors = [];

  // ── Config: parse + V2 shape ─────────────────────────────────────────────
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`  ✗  config.jsonc — not found at ${CONFIG_PATH}`);
    errors.push('config.jsonc missing');
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(stripJsonc(fs.readFileSync(CONFIG_PATH, 'utf8')));
      console.log('  ✓  config.jsonc parses (// comments + trailing commas stripped)');
    } catch (err) {
      console.log(`  ✗  config.jsonc — JSON parse failed: ${err.message}`);
      errors.push('config.jsonc does not parse');
    }

    if (parsed) {
      if (Object.prototype.hasOwnProperty.call(parsed, 'permission')) {
        console.log("  ✗  config.jsonc — top-level 'permission' (singular) present; V1 shape is ignored");
        errors.push("top-level 'permission' present");
      } else {
        console.log("  ✓  no top-level 'permission' (singular)");
      }

      if (Array.isArray(parsed.permissions)) {
        console.log(`  ✓  permissions is an array (${parsed.permissions.length} rules, V2 shape)`);
      } else {
        console.log("  ✗  config.jsonc — 'permissions' is missing or not an array (V2 shape)");
        errors.push("permissions is not an array");
      }

      // ── Overlay top-level key classification ─────────────────────────────
      // Static and overlay-only: a new overlay key must be classified as
      // SHARED, CONFIG_EXEMPT, or CONVERGE_MANAGED before it can ship. An
      // unclassified key is fail-closed: the convergence mechanism would not
      // know whether writing it is safe.
      const classified = new Set([
        ...SHARED,
        ...CONFIG_EXEMPT,
        ...CONVERGE_MANAGED,
      ]);
      const unclassified = Object.keys(parsed).filter((k) => !classified.has(k));
      if (unclassified.length > 0) {
        for (const key of unclassified) {
          console.log(`  ✗  config.jsonc — unclassified overlay key: ${key}`);
          errors.push(`unclassified overlay key: ${key}`);
        }
      } else {
        console.log(`  ✓  all ${Object.keys(parsed).length} overlay top-level keys are classified`);
      }

      // ── Managed-key value shape ───────────────────────────────────────────
      // Classification alone lets a renamed or wrong-typed sub-key ship green:
      // the host drops unknown sub-properties and coerces mismatched types, so
      // the cap it names silently reverts to the built-in default. Pin the
      // declared shape of the cap-bearing object keys (fail closed). Overlay
      // only — the live file is never read here.
      //
      // First assert coverage: every CONVERGE_MANAGED key must carry a shape
      // spec, so a new managed key cannot ship without one (the two
      // declarations stay coupled by a checked invariant, not a comment).
      const coverage = checkShapeCoverage(CONVERGE_MANAGED);
      for (const line of coverage.lines) console.log(line);
      errors.push(...coverage.errors);

      const shape = checkConfigShape(parsed);
      for (const line of shape.lines) console.log(line);
      errors.push(...shape.errors);
    }
  }

  // ── Agents: model tier pins ──────────────────────────────────────────────
  // Discover the fleet rather than enumerate it (n=30 next-hypothesis (b)): the
  // check below walks every *.md the reader returns, so a newly added agent is
  // covered with no table edit.
  const discovered = fs.existsSync(AGENTS_DIR)
    ? fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).sort()
    : [];
  const fleet = checkAgentFleet(
    discovered,
    (name) => fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8'),
  );
  for (const line of fleet.lines) console.log(line);
  errors.push(...fleet.errors);

  // ── UI config gate: no plugin refs, and permissions stay interactive ─────
  // `autoaccept` would accept the overlay's `ask` gates without a human, which
  // makes them inert. Fail closed on that, and on any plugin entry, so the
  // retired add-on cannot creep back through the UI config.
  for (const name of ['cli.json', 'tui.json']) {
    const p = path.join(OVERLAY_DIR, name);
    if (!fs.existsSync(p)) {
      console.log(`  ✗  ui ${name} — missing golden file`);
      errors.push(`ui ${name} missing`);
      continue;
    }
    let ui;
    try { ui = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8'))); }
    catch (e) {
      console.log(`  ✗  ui ${name} — does not parse: ${e.message}`);
      errors.push(`ui ${name} unparseable`);
      continue;
    }
    const pluginKeys = ['plugins', 'plugin'].filter((k) => k in ui);
    if (pluginKeys.length) {
      console.log(`  ✗  ui ${name} — carries plugin refs: ${pluginKeys.join(', ')}`);
      errors.push(`ui ${name} plugin refs`);
    }
    if (name === 'cli.json') {
      const mode = ui.session && ui.session.permissions;
      if (mode !== 'prompt') {
        console.log(`  ✗  ui cli.json — session.permissions is '${mode}', expected 'prompt'`);
        errors.push('ui cli.json permissions not prompt');
      } else {
        console.log("  ✓  ui cli.json — session.permissions is 'prompt'");
      }
    }
    if (!pluginKeys.length && (name !== 'cli.json' || (ui.session && ui.session.permissions === 'prompt'))) {
      console.log(`  ✓  ui ${name} — no plugin refs`);
    }
  }

  const status = errors.length > 0 ? 'FAILED' : 'PASSED';
  console.log(`\nconfig check — ${errors.length} error(s) — ${status}`);

  if (errors.length > 0) process.exit(1);
}

module.exports = { stripJsonc, checkAgentFleet, parseFrontmatter, EXPECTED_MODELS };

if (require.main === module) main();
