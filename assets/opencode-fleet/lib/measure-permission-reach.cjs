#!/usr/bin/env node
/**
 * measure-permission-reach.cjs
 *
 * A read-only instrument for the permission-declaration plane. Two iterations
 * shipped permission rules into the golden config and both recorded the same
 * residual as prose: the port "is inert on a machine with an existing live
 * config (`permissions` is convergence-exempt), so it reaches fresh installs
 * only" (n=33 `losses/at-risk regressions`; n=36 `losses / residuals` (a)).
 * No file measured that. This ruler replaces the caveat with a number: for each
 * rule the golden config declares, is it PRESENT in the live config the host
 * actually loads (the global `~/.config/opencode/opencode.jsonc`)?
 *
 * Why it matters: `install/lib/validate-config.cjs` classifies `permissions` as
 * `CONFIG_EXEMPT`, and `install/30-settings.sh` deploys the config by value
 * comparison, so a live file that already exists is left in place unless
 * FORCE=1. A rule therefore ships in the repo and never runs on the machine.
 * This instrument measures that gap instead of asserting it.
 *
 * MISLABELING WARNING (the reason this is a ruler, not a one-liner): reach is
 * set membership, not rule count. A golden rule is "reachable" only when an
 * EQUAL (action, resource, effect) triple is present in live. A live rule with
 * the same action and resource but a different effect does NOT make the golden
 * rule reachable — the host resolves by its own array, so a `deny` in the repo
 * that lives only as an `ask` on this machine does not deny. `inert` is
 * reported as a rule count and a rate, never merged with "live has fewer rules".
 *
 * SCOPE: the global live config only. A project-level `.opencode/opencode.jsonc`
 * is not read (the golden overlay deploys the global file; project configs are
 * out of the deploy path). This is a measurement, not a gate: it reads machine
 * state on purpose, which is why the commit-time validators stay overlay-only
 * and only this ruler's deterministic fixture suite runs in the hook.
 *
 * Read-only: reads two config files, never writes, no store, no network.
 * Absence of the live file is a graceful SKIP (exit 0: a fresh machine has
 * nothing to measure against). A golden config that is unreadable, unparseable,
 * or whose `permissions` is not an array is an error (exit 1) — that is repo
 * state and must fail loud. A live file that exists but is unparseable is an
 * error too: presence with unreadable content is not the same as absence.
 *
 * Usage:
 *   node install/lib/measure-permission-reach.cjs [--golden PATH] [--live PATH]
 *        [--json]
 *
 * Exit codes: 0 = measured or skipped, 1 = error, 2 = usage error.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Reuse the canonical JSONC normalizer so the instrument and the validator
// cannot disagree about what the config says (one parser, one answer).
const { stripJsonc } = require('./validate-config.cjs');

const GOLDEN_DEFAULT = path.resolve(__dirname, '..', 'opencode', 'config.jsonc');
const LIVE_DEFAULT   = path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc');

// The generated blocks in the golden config are delimited by sentinel comments
// (the same ones `port-secret-read-rules.cjs` / `port-destructive-rules.cjs`
// write and `--check` enforces). Matching on a distinctive substring keeps this
// ruler independent of the generators' exact spacing.
const BLOCKS = [
  { name: 'secret-read',  begin: '>>> ported-secret-read-rules',  end: '<<< ported-secret-read-rules' },
  { name: 'destructive',  begin: '>>> ported-destructive-rules',  end: '<<< ported-destructive-rules' },
];

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Compare one rule by the triple the host resolves on. Tolerates a bad shape. */
function ruleKey(rule) {
  if (!rule || typeof rule !== 'object') return '(malformed)';
  return `${rule.action}|${rule.resource}|${rule.effect}`;
}

/** Increment `m[key]` in a plain-object counter. */
function bump(m, key) { m[key] = (m[key] || 0) + 1; }

/**
 * Parse a config text into a rules array. Returns `{ rules }` or `{ error }`.
 * A missing or non-array `permissions` is an error (fail loud), not an empty
 * measurement — the whole point is to count what the file declares.
 */
function rulesFromText(text) {
  let parsed;
  try { parsed = JSON.parse(stripJsonc(text)); }
  catch (err) { return { error: `config does not parse as JSONC: ${err.message}` }; }
  const rules = parsed ? parsed.permissions : undefined;
  if (!Array.isArray(rules)) return { error: 'top-level `permissions` is not an array' };
  return { rules };
}

/**
 * The block label for each rule, in file order, by walking the raw text and
 * tracking which sentinel region each rule line falls in. A rule line is a line
 * whose first non-space characters are `{ "action"`. Returns an array of labels
 * the same length as the parsed rules, or `null` when the raw scan and the
 * parse disagree (a format change the ruler must not silently mis-attribute).
 */
function blockLabels(text, ruleCount) {
  const lines = text.split('\n');
  const labels = [];
  let current = 'hand-written';
  const active = new Set();
  for (const line of lines) {
    for (const b of BLOCKS) {
      if (line.includes(b.begin)) { active.add(b.name); current = b.name; }
      if (line.includes(b.end))   { active.delete(b.name); current = active.size ? [...active][0] : 'hand-written'; }
    }
    if (/^\s*\{\s*"action"\s*:/.test(line)) labels.push(current);
  }
  if (labels.length !== ruleCount) return null;
  return labels;
}

/**
 * The reach census: which golden rules are present (by key) in the live config.
 * `labels` (optional) splits the inert set by origin block; when it is null the
 * split is omitted rather than guessed.
 */
function reach(goldenRules, liveRules, labels) {
  const liveKeys = new Set(liveRules.map(ruleKey));
  const goldenKeys = new Set(goldenRules.map(ruleKey));

  const inert = [];
  goldenRules.forEach((rule, i) => {
    if (!liveKeys.has(ruleKey(rule))) inert.push({ rule, i });
  });
  const liveOnly = liveRules.filter((rule) => !goldenKeys.has(ruleKey(rule)));

  const byAction = {};
  const byEffect = {};
  const byBlock  = {};
  for (const { rule, i } of inert) {
    bump(byAction, rule && rule.action != null ? rule.action : '(none)');
    bump(byEffect, rule && rule.effect != null ? rule.effect : '(none)');
    if (labels) bump(byBlock, labels[i]);
  }

  const total = goldenRules.length;
  return {
    golden: total,
    live: liveRules.length,
    reachable: total - inert.length,
    inert: inert.length,
    inertRate: total > 0 ? inert.length / total : 0,
    byAction,
    byEffect,
    byBlock: labels ? byBlock : null,
    liveOnly: liveOnly.length,
  };
}

// ─── File access (skip-vs-error semantics) ───────────────────────────────────

/**
 * Read a config file and return `{ text }`, `{ skipped }`, or `{ error }`.
 * `absent` names what a missing file means: the golden config is repo state
 * (absence is an error), the live config is machine state (absence is a skip).
 */
function readConfig(filePath, { absentIsSkip }) {
  if (!fs.existsSync(filePath)) {
    return absentIsSkip ? { skipped: `no live config at ${filePath}` } : { error: `missing config at ${filePath}` };
  }
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (err) { return { error: `cannot read ${filePath}: ${err.message}` }; }
  return { text };
}

/** Full measurement used by the CLI, preserving skip/error. */
function measure(options = {}) {
  const goldenPath = options.goldenPath || GOLDEN_DEFAULT;
  const livePath   = options.livePath   || LIVE_DEFAULT;

  const g = readConfig(goldenPath, { absentIsSkip: false });
  if (g.error) return { skipped: null, error: g.error };
  const gParsed = rulesFromText(g.text);
  if (gParsed.error) return { skipped: null, error: `golden: ${gParsed.error}` };

  const l = readConfig(livePath, { absentIsSkip: true });
  if (l.error) return { skipped: null, error: l.error };
  if (l.skipped) return { skipped: l.skipped, error: null };
  const lParsed = rulesFromText(l.text);
  if (lParsed.error) return { skipped: null, error: `live: ${lParsed.error}` };

  const labels = blockLabels(g.text, gParsed.rules.length);
  return { skipped: null, error: null, goldenPath, livePath, ...reach(gParsed.rules, lParsed.rules, labels) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { goldenPath: GOLDEN_DEFAULT, livePath: LIVE_DEFAULT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--golden')      { const v = argv[++i]; if (v == null) return { error: '--golden requires a path' }; opts.goldenPath = v; }
    else if (a === '--live')   { const v = argv[++i]; if (v == null) return { error: '--live requires a path' }; opts.livePath = v; }
    else if (a === '--json')   opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return opts;
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: measure-permission-reach.cjs [--golden PATH] [--live PATH] [--json]');
    return 0;
  }

  const result = measure(opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.error) {
    console.error(`  \u2717  permission-reach ruler failed \u2014 ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  permission-reach ruler skipped \u2014 ${result.skipped}`);
  } else {
    console.log('permission reach (golden config vs live config)');
    console.log(`  ${result.golden} golden rule(s); ${result.live} live rule(s)`);
    console.log(`  ${result.inert} rule(s) inert on this machine (${pct(1 - result.inertRate)} reachable)`);
    const byAction = Object.entries(result.byAction).map(([k, n]) => `${k} ${n}`).join(', ');
    if (byAction) console.log(`  by action: ${byAction}`);
    const byEffect = Object.entries(result.byEffect).map(([k, n]) => `${k} ${n}`).join(', ');
    if (byEffect) console.log(`  by effect: ${byEffect}`);
    if (result.byBlock) {
      const byBlock = Object.entries(result.byBlock).map(([k, n]) => `${k} ${n}`).join(', ');
      if (byBlock) console.log(`  by block: ${byBlock}`);
    }
    console.log(`  live-only: ${result.liveOnly} rule(s) not declared in the golden config`);
  }

  if (result.error) return 1;
  return 0;
}

module.exports = {
  ruleKey,
  rulesFromText,
  blockLabels,
  reach,
  readConfig,
  measure,
  parseArgs,
  main,
  GOLDEN_DEFAULT,
  LIVE_DEFAULT,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
