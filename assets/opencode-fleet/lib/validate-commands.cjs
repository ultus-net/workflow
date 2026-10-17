#!/usr/bin/env node
/**
 * validate-commands.cjs
 *
 * Validates the OpenCode command fleet in install/opencode/commands/. The golden
 * tree install/opencode/ is the single deploy source; the live
 * ~/.config/opencode/commands path symlinks straight into it.
 *
 * The command plane is the one plane with no validator: config has
 * validate-config.cjs, agents have validate-agents.cjs, and skills have
 * validate-skills.cjs. A command whose frontmatter the host silently drops, or
 * whose declared `agent` names nothing, ships as a silent no-op.
 *
 * Checks (errors block CI):
 *   - every *.md has YAML frontmatter with a non-empty 'description'
 *   - 'description', 'agent', and 'model' are YAML strings (a bare boolean or
 *     null fails the host's Schema.String and drops the whole command)
 *   - `agent`, when present, names a known agent: a file in
 *     install/opencode/agents/ or a host built-in (build/plan/general/explore);
 *     an empty `agent:` is an error (it resolves to no agent, like a typo)
 *   - `subagent` / `subtask`, when present, are the bare booleans true/false,
 *     and not both present at once
 *   - every other frontmatter key is one the host's Config.Command decodes;
 *     an unlocked key is IGNORED by the host (onExcessProperty: "ignore"), so
 *     an inert key is an error, not a skip
 *   - `model`, when present, matches the host guard /^[^\/#]+\/[^#]+$/
 *   - no frontmatter key is declared twice (the host's YAML parser silently
 *     last-wins)
 *   - no nested command directories (the host globs commands/**\/*.md
 *     recursively, but this verifier only validates top-level files)
 *
 * Checks (warnings, do not block CI):
 *   - `subtask` is accepted but deprecated in favour of `subagent`
 *   - a frontmatter `template` is overwritten by the body, so it is inert
 *
 * COMMANDS_DIR / AGENTS_DIR can be overridden by env for tests.
 *
 * Exit codes: 0 = all clear, 1 = one or more errors
 */

'use strict';

// Reads the staged content under OPENCODE_VALIDATE_INDEX=1 (pre-commit), so the
// command gate validates the commit, not the working tree.
const fs   = require('./index-read.cjs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const COMMANDS_DIR = process.env.COMMANDS_DIR ||
  path.resolve(__dirname, '..', 'opencode', 'commands');

const AGENTS_DIR = process.env.AGENTS_DIR ||
  path.resolve(__dirname, '..', 'opencode', 'agents');

// Host built-in agent ids (running host opencode v2.0.10). The agent plugin
// seeds these before any config agent is merged, so a command may target one
// without a matching file in install/opencode/agents/.
//   - build:   AgentV2.defaultID ("build"), the default primary agent
//   - plan, general, explore: seeded by name in the agent plugin
// Source: packages/core/src/agent.ts (defaultID) and
// packages/core/src/plugin/agent.ts (plan/general/explore seeds); the v2.0.10
// binary carries the same ids (`.make("build"|"plan"|"general"|"explore")`).
// `compaction` is host-internal and not addressable from a command, so it is
// not listed.
const BUILTIN_AGENTS = new Set(['build', 'plan', 'general', 'explore']);

// The frontmatter keys the host's Config.Command decodes (running host
// opencode v2.0.10). Pinned from the binary class
// `class Mg extends yt("Config.Command")({template, description, agent, model,
// subagent, subtask})`. `template` is present in the schema but is always
// overwritten by the markdown body (decode spreads `...markdown.data` then sets
// `template: markdown.content.trim()`), so a frontmatter `template` is inert
// and only warned about. The schema decodes with `onExcessProperty: "ignore"`
// (the v2 binary), so any key outside this set is silently dropped — inert.
const KNOWN_KEYS = new Set(['description', 'agent', 'model', 'subagent', 'subtask']);

// A `provider/model` reference. The host validates a command `model` with the
// binary's `zI` guard `/^[^/#]+\/[^#]+$/` (running host opencode v2.0.10): the
// provider has no slash or hash, and the model may itself contain slashes
// (`synthetic/hf:moonshotai/Kimi-K3`) but no hash. Mirrored exactly so the gate
// never rejects a command the host honors.
const MODEL_RE = /^[^/#]+\/[^#]+$/;

// A bare YAML scalar that is NOT a string: the host's Schema.String fields
// (description/agent/model) fail to decode a boolean, null, or number, dropping
// the command. Only bare tokens count — a quoted "true" or "5" is a YAML string
// and passes. The number alternatives mirror the YAML 1.2 core schema (int,
// hex, octal, float, exponent, .inf/.nan).
const NON_STRING_SCALAR_RE = new RegExp(
  '^(?:' +
  'true|false|True|False|TRUE|FALSE|null|Null|NULL|~' +
  '|[-+]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|[0-9][0-9_]*(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?)' +
  '|[-+]?\\.(?:inf|Inf|INF|nan|NaN|NAN)' +
  ')$',
);

/** Name the non-string YAML type a bare scalar resolves to, for messages. */
function yamlTypeName(token) {
  if (/^(null|Null|NULL|~)$/.test(token)) return 'null';
  if (/^(true|false|True|False|TRUE|FALSE)$/.test(token)) return 'boolean';
  return 'number';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse YAML-style frontmatter from the top of a markdown file.
 * Returns { keys, duplicates } where keys is a key→value object (top-level keys
 * only, values as written) and duplicates lists keys declared more than once
 * (the host's YAML parser silently last-wins). Returns null if no frontmatter
 * block found. The raw value is preserved (quotes intact) so a quoted boolean
 * (`subagent: "true"`, a YAML string the host rejects) is distinguishable from
 * the bare boolean. Use `unquote` for string fields.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  if (!match) return null;

  const keys = {};
  const seen = new Set();
  const duplicates = [];
  for (const line of match[1].split(/\r?\n/)) {
    // Only top-level keys (column 0). Nested/indented lines are not keys.
    if (/^\s/.test(line)) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
    keys[key] = raw;
  }
  return { keys, duplicates };
}

/** Strip surrounding quotes and an inline comment from a frontmatter scalar. */
function unquote(raw) {
  if (raw == null) return raw;
  const noComment = raw.replace(/\s+#.*$/, '').trim();
  return noComment.replace(/^["']|["']$/g, '');
}

// The YAML 1.2 core-schema boolean spellings the host's Schema.Boolean accepts
// when the value is written BARE. A quoted value is a YAML string and fails the
// boolean decode, dropping the whole command.
const BARE_BOOLEAN_RE = /^(true|false|True|False|TRUE|FALSE)$/;

// ─── Validator ───────────────────────────────────────────────────────────────

/**
 * Validate one command's text. Pure: takes the text and the set of known agent
 * names, returns { errors, warnings }. `name` is used only in messages.
 */
function validateCommand(name, content, knownAgents) {
  const errors   = [];
  const warnings = [];

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    errors.push('Missing or malformed YAML frontmatter (expected --- block at top of file)');
    return { errors, warnings };
  }
  const fm = parsed.keys;

  // ── duplicate keys: the host's YAML parser silently last-wins ─────────────
  for (const k of [...new Set(parsed.duplicates)].sort()) {
    errors.push(`frontmatter key '${k}' is declared more than once (the host's YAML parser silently keeps the last)`);
  }

  // ── description: the discovery surface, and a Schema.String ──────────────
  const description = unquote(fm.description);
  if (fm.description === undefined || description.trim() === '') {
    errors.push("Frontmatter missing required non-empty field: 'description'");
  } else if (NON_STRING_SCALAR_RE.test(fm.description)) {
    errors.push(
      `'description: ${fm.description}' is a YAML ${yamlTypeName(fm.description)}, not a string; the host ` +
      `schema is Schema.String, so the whole command fails decode and is silently dropped`);
  }

  // ── agent: must resolve, or the command silently runs the default agent ───
  // AgentV2.resolve returns `info: undefined` for an unknown id (no throw), so a
  // dangling reference is a silent fallback, not an error at runtime. An empty
  // `agent:` is the same failure: the host applies `item.agent = ''`, which
  // resolves to undefined.
  const agent = unquote(fm.agent);
  if (fm.agent !== undefined) {
    if (NON_STRING_SCALAR_RE.test(fm.agent)) {
      errors.push(`'agent: ${fm.agent}' is a YAML ${yamlTypeName(fm.agent)}, not a string (host schema is Schema.String)`);
    } else if (!knownAgents.has(agent)) {
      const shown = agent === '' ? "(empty)" : agent;
      errors.push(
        `'agent: ${shown}' names no known agent (not a file in agents/ and not a ` +
        `host built-in: ${[...BUILTIN_AGENTS].join(', ')}); the host resolves an unknown ` +
        `id to undefined and silently falls back to the default agent`);
    }
  }

  // ── subagent / subtask: booleans, and not both ───────────────────────────
  // The value must be written bare: a quoted "true" is a YAML string and fails
  // the host's Schema.Boolean, dropping the whole command.
  for (const key of ['subagent', 'subtask']) {
    if (fm[key] === undefined) continue;
    if (!BARE_BOOLEAN_RE.test(fm[key].replace(/\s+#.*$/, '').trim())) {
      errors.push(
        `'${key}: ${fm[key]}' is not a boolean; the host schema is Schema.Boolean, so the ` +
        `whole command fails decode and is silently dropped (write a bare true/false, not a quoted string)`);
    }
  }
  if (fm.subagent !== undefined && fm.subtask !== undefined) {
    errors.push("both 'subagent' and 'subtask' are set; 'subtask' is a deprecated alias — use 'subagent' only");
  }
  if (fm.subtask !== undefined) {
    warnings.push("'subtask' is deprecated (host alias for 'subagent'); prefer 'subagent'");
  }
  if (fm.template !== undefined) {
    warnings.push("frontmatter 'template' is overwritten by the markdown body; it has no effect");
  }

  // ── model ────────────────────────────────────────────────────────────────
  const model = unquote(fm.model);
  if (fm.model !== undefined) {
    if (NON_STRING_SCALAR_RE.test(fm.model)) {
      errors.push(`'model: ${fm.model}' is a YAML ${yamlTypeName(fm.model)}, not a string (host schema is Schema.String)`);
    } else if (!MODEL_RE.test(model)) {
      errors.push(`'model: ${model}' is not 'provider/model' (host guard /^[^\\/#]+\\/[^#]+$/)`);
    }
  }

  // ── unknown keys are inert (host decodes with onExcessProperty: ignore) ────
  const unknown = Object.keys(fm).filter((k) => k !== 'template' && !KNOWN_KEYS.has(k));
  for (const k of unknown.sort()) {
    errors.push(
      `unknown frontmatter key '${k}' (the host decodes a command with onExcessProperty: ` +
      `"ignore", so the key is silently dropped — remove it or use a decoded key)`);
  }

  return { errors, warnings };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(COMMANDS_DIR)) {
    console.error(`ERROR: commands directory not found at ${COMMANDS_DIR}`);
    process.exit(1);
  }

  // Known agents: every fleet agent file, plus the host built-ins.
  const knownAgents = new Set(BUILTIN_AGENTS);
  if (fs.existsSync(AGENTS_DIR)) {
    for (const f of fs.readdirSync(AGENTS_DIR)) {
      if (f.endsWith('.md')) knownAgents.add(f.replace(/\.md$/, ''));
    }
  }

  const commandFiles = fs.readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.md') && fs.statSync(path.join(COMMANDS_DIR, f)).isFile())
    .sort();

  // Fail-closed on nested entries: the host globs commands/**/*.md recursively,
  // but this verifier only validates top-level files. Any subdirectory is an
  // error so a nested command cannot bypass the checks.
  const nestedDirs = fs.readdirSync(COMMANDS_DIR)
    .filter(f => fs.statSync(path.join(COMMANDS_DIR, f)).isDirectory());

  let totalErrors   = 0;
  let totalWarnings = 0;

  // Fail-closed on an empty set: a command tree with no *.md means the deploy
  // source lost every command (a mass deletion or a wrong dir), not a clean
  // pass. Same shape as L023 — an empty input must not read as success.
  if (commandFiles.length === 0 && nestedDirs.length === 0) {
    console.error(`ERROR: no commands found in ${COMMANDS_DIR} (expected the deployed fleet; an empty tree is a failure, not a pass)`);
    process.exit(1);
  }

  for (const dir of nestedDirs) {
    totalErrors++;
    console.log(`  ✗  ${dir}/`);
    console.log('       ERROR: nested command directory not supported (fleet is flat); move the command to the top level');
  }

  for (const name of commandFiles) {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, name), 'utf8');
    const { errors, warnings } = validateCommand(name, content, knownAgents);
    totalErrors   += errors.length;
    totalWarnings += warnings.length;

    if (errors.length === 0 && warnings.length === 0) {
      console.log(`  ✓  ${name}`);
    } else {
      const icon = errors.length > 0 ? '  ✗ ' : '  ⚠ ';
      console.log(`${icon} ${name}`);
      for (const msg of errors)   console.log(`       ERROR: ${msg}`);
      for (const msg of warnings) console.log(`       WARN:  ${msg}`);
    }
  }

  const status = totalErrors > 0 ? 'FAILED' : totalWarnings > 0 ? 'PASSED WITH WARNINGS' : 'PASSED';
  console.log(`\n${commandFiles.length} commands checked — ${totalErrors} error(s), ${totalWarnings} warning(s) — ${status}`);

  if (totalErrors > 0) process.exit(1);
}

module.exports = {
  validateCommand,
  parseFrontmatter,
  KNOWN_KEYS,
  BUILTIN_AGENTS,
};

if (require.main === module) main();
