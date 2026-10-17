#!/usr/bin/env node
/**
 * test-measure-permission-reach.cjs
 *
 * Fixtures for measure-permission-reach.cjs. Pins the instrument's pure logic:
 * the reach key (action+resource+effect), the fail-loud contracts on an
 * unparseable or non-array config, the block attribution by sentinel, the
 * skip-on-absent-live path, and the critical "an effect-only mismatch is inert"
 * case, which is what keeps the census from crediting a rule that does not
 * actually deny on this machine.
 *
 * The instrument reads machine state at run time, so the hook runs only these
 * fixtures (never the ruler against the live file) — the logic is where the
 * risk is, and the fixtures carry it.
 *
 * Run: node --test install/lib/test-measure-permission-reach.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const m = require('./measure-permission-reach.cjs');

const rule = (action, resource, effect) => ({ action, resource, effect });

// ─── ruleKey ─────────────────────────────────────────────────────────────────

test('ruleKey: the host triple, and a tolerant fallback for a bad shape', () => {
  assert.equal(m.ruleKey(rule('read', '*.env', 'deny')), 'read|*.env|deny');
  assert.equal(m.ruleKey(null), '(malformed)');
  assert.equal(m.ruleKey('x'), '(malformed)');
});

// ─── rulesFromText ───────────────────────────────────────────────────────────

test('rulesFromText: parses JSONC with comments and trailing commas', () => {
  const text = `{
    // a comment
    "permissions": [
      { "action": "read", "resource": "*.env", "effect": "deny" }, // trailing
    ],
  }`;
  const out = m.rulesFromText(text);
  assert.equal(out.error, undefined);
  assert.equal(out.rules.length, 1);
  assert.deepEqual(out.rules[0], rule('read', '*.env', 'deny'));
});

test('rulesFromText: fails loud on unparseable JSONC', () => {
  const out = m.rulesFromText('{ not json');
  assert.match(out.error, /does not parse/);
});

test('rulesFromText: fails loud when permissions is not an array', () => {
  assert.match(m.rulesFromText('{ "permissions": {} }').error, /not an array/);
  assert.match(m.rulesFromText('{ "foo": 1 }').error, /not an array/);
});

// ─── reach ───────────────────────────────────────────────────────────────────

test('reach: a present key is reachable, an absent key is inert', () => {
  const golden = [rule('read', '*.env', 'deny'), rule('shell', 'rm -rf *', 'ask')];
  const live   = [rule('read', '*.env', 'deny')];
  const out = m.reach(golden, live, null);
  assert.equal(out.golden, 2);
  assert.equal(out.live, 1);
  assert.equal(out.reachable, 1);
  assert.equal(out.inert, 1);
  assert.equal(out.inertRate, 0.5);
  assert.deepEqual(out.byAction, { shell: 1 });
  assert.deepEqual(out.byEffect, { ask: 1 });
  assert.equal(out.byBlock, null);
});

test('reach: an effect-only mismatch is INERT (not reachable)', () => {
  // Same action+resource, different effect: the golden `deny` does not deny on
  // this machine, so it must count as inert. This is the load-bearing fixture.
  const golden = [rule('shell', 'git push --force *', 'deny')];
  const live   = [rule('shell', 'git push --force *', 'ask')];
  const out = m.reach(golden, live, null);
  assert.equal(out.inert, 1);
  assert.equal(out.reachable, 0);
  assert.equal(out.liveOnly, 1, 'the differing live rule surfaces as live-only');
});

test('reach: live-only counts rules the golden config does not declare', () => {
  const golden = [rule('read', '*.env', 'deny')];
  const live   = [rule('read', '*.env', 'deny'), rule('edit', '.opencode/**', 'deny'), rule('edit', '.opencode/**', 'deny')];
  const out = m.reach(golden, live, null);
  assert.equal(out.inert, 0);
  assert.equal(out.liveOnly, 2, 'units, not distinct keys');
});

test('reach: byBlock splits the inert set when labels are supplied', () => {
  const golden = [rule('read', '*id_rsa', 'deny'), rule('shell', 'kubectl delete *', 'ask'), rule('edit', '*.env*', 'deny')];
  const live   = [rule('edit', '*.env*', 'deny')];
  const out = m.reach(golden, live, ['secret-read', 'destructive', 'hand-written']);
  assert.equal(out.inert, 2);
  assert.deepEqual(out.byBlock, { 'secret-read': 1, destructive: 1 });
});

test('reach: an empty golden set yields a zero rate, never NaN', () => {
  const out = m.reach([], [], null);
  assert.equal(out.inertRate, 0);
  assert.equal(out.inert, 0);
});

// ─── blockLabels ─────────────────────────────────────────────────────────────

test('blockLabels: attributes rules to their sentinel region in file order', () => {
  const text = [
    '{',
    '  "permissions": [',
    '    { "action": "edit", "resource": ".opencode/**", "effect": "deny" },',
    '    // >>> ported-secret-read-rules (generated) <<<',
    '    { "action": "read", "resource": "*id_rsa", "effect": "deny" },',
    '    // <<< ported-secret-read-rules <<<',
    '    // >>> ported-destructive-rules (generated) <<<',
    '    { "action": "shell", "resource": "kubectl delete *", "effect": "ask" },',
    '    // <<< ported-destructive-rules <<<',
    '  ],',
    '}',
  ].join('\n');
  const labels = m.blockLabels(text, 3);
  assert.deepEqual(labels, ['hand-written', 'secret-read', 'destructive']);
});

test('blockLabels: returns null when the scan and the parse disagree', () => {
  const text = '{ "permissions": [ { "action": "read", "resource": "x", "effect": "deny" } ] }';
  // 1 rule line scanned, but the caller claims 2 parsed -> a format change.
  assert.equal(m.blockLabels(text, 2), null);
});

test('blockLabels: a rule with a different key order is not counted as a rule line', () => {
  // Only lines beginning `{ "action"` count; a reordered object would be missed,
  // and blockLabels then signals null via the length check rather than guessing.
  const text = '{ "permissions": [ { "resource": "x", "action": "read", "effect": "deny" } ] }';
  assert.equal(m.blockLabels(text, 1), null);
});

// ─── measure (file access + skip/error semantics) ────────────────────────────

function tmpConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  const p = path.join(dir, 'opencode.jsonc');
  fs.writeFileSync(p, content);
  return p;
}

test('measure: counts the gap between a golden and a live config', () => {
  const golden = tmpConfig(`{ "permissions": [
    { "action": "read", "resource": "*.env", "effect": "deny" },
    { "action": "shell", "resource": "kubectl delete *", "effect": "ask" },
  ] }`);
  const live = tmpConfig(`{ "permissions": [
    { "action": "read", "resource": "*.env", "effect": "deny" },
  ] }`);
  const out = m.measure({ goldenPath: golden, livePath: live });
  assert.equal(out.error, null);
  assert.equal(out.golden, 2);
  assert.equal(out.live, 1);
  assert.equal(out.inert, 1);
  assert.equal(out.reachable, 1);
});

test('measure: an absent live config is a graceful skip', () => {
  const golden = tmpConfig('{ "permissions": [] }');
  const out = m.measure({ goldenPath: golden, livePath: path.join(os.tmpdir(), 'reach-does-not-exist.jsonc') });
  assert.equal(out.error, null);
  assert.match(out.skipped, /no live config/);
});

test('measure: an absent golden config is an error (repo state, not machine state)', () => {
  const live = tmpConfig('{ "permissions": [] }');
  const out = m.measure({ goldenPath: path.join(os.tmpdir(), 'reach-no-golden.jsonc'), livePath: live });
  assert.match(out.error, /missing config/);
});

test('measure: a present-but-unparseable live config is an error, not a skip', () => {
  const golden = tmpConfig('{ "permissions": [] }');
  const live   = tmpConfig('{ not json');
  const out = m.measure({ goldenPath: golden, livePath: live });
  assert.match(out.error, /live:/);
});

test('measure: a non-array permissions in the golden config is an error', () => {
  const golden = tmpConfig('{ "permissions": {} }');
  const live   = tmpConfig('{ "permissions": [] }');
  const out = m.measure({ goldenPath: golden, livePath: live });
  assert.match(out.error, /golden:.*not an array/);
});

test('measure: real golden config reconciles to the generator blocks', () => {
  // Derive the two generated block sizes from the generators themselves (their
  // single source of truth), so a change to a class table moves this fixture
  // rather than making the census stale. The hand-written remainder is whatever
  // the golden config declares beyond the two generated blocks.
  const secret = require('./port-secret-read-rules.cjs');
  const destructive = require('./port-destructive-rules.cjs');
  const secretN = secret.ruleLines().length;
  const destructiveN = destructive.ruleLines().length;

  const live = tmpConfig('{ "permissions": [] }');
  const out = m.measure({ livePath: live });
  assert.equal(out.error, null);
  assert.equal(out.inert, out.golden, 'an empty live config makes every rule inert');
  assert.equal(out.byBlock['secret-read'], secretN);
  assert.equal(out.byBlock.destructive, destructiveN);
  assert.equal(out.byBlock['hand-written'], out.golden - secretN - destructiveN);
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test('parseArgs: defaults, overrides, and a usage error', () => {
  const d = m.parseArgs([]);
  assert.equal(d.error, undefined);
  assert.match(d.goldenPath, /config\.jsonc$/);
  const o = m.parseArgs(['--golden', '/g', '--live', '/l', '--json']);
  assert.equal(o.goldenPath, '/g');
  assert.equal(o.livePath, '/l');
  assert.equal(o.json, true);
  assert.equal(m.parseArgs(['--golden']).error, '--golden requires a path');
  assert.equal(m.parseArgs(['--nope']).error, 'unknown argument: --nope');
});

test('CLI: prints a census and exits 0 on the real tree', () => {
  const secret = require('./port-secret-read-rules.cjs');
  const destructive = require('./port-destructive-rules.cjs');
  const live = tmpConfig('{ "permissions": [] }');
  const out = require('node:child_process').execFileSync(
    process.execPath,
    [path.join(__dirname, 'measure-permission-reach.cjs'), '--live', live],
    { encoding: 'utf8' },
  );
  assert.match(out, /permission reach/);
  // The block breakdown must equal what the generators emit, derived not pinned.
  assert.match(out, new RegExp(`by block: hand-written \\d+, secret-read ${secret.ruleLines().length}, destructive ${destructive.ruleLines().length}`));
  const golden = m.measure({ livePath: live }).golden;
  assert.match(out, new RegExp(`${golden} golden rule\\(s\\)`));
});

// ─── live-path parity with the installer ─────────────────────────────────────
// LIVE_DEFAULT hardcodes the live config path, which also appears in the
// installer that deploys it (`install/30-settings.sh`). Nothing coupled the two
// (review W3), so a path change on one side would silently point the ruler at a
// file the host never loads. This asserts the suffix parity by reading the
// installer, the same way test-measure-tool-output.cjs couples its cap constant
// to the overlay (n=28 P2).

test('LIVE_DEFAULT points at the path the installer deploys', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', '30-settings.sh'), 'utf8');
  // The installer's live config path, e.g. "$HOME/.config/opencode/opencode.jsonc".
  assert.match(installer, /\$HOME\/\.config\/opencode\/opencode\.jsonc/,
    'the installer still deploys the live config at $HOME/.config/opencode/opencode.jsonc');
  // The ruler's default must be that same suffix under the home directory.
  assert.equal(m.LIVE_DEFAULT, path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'));
  assert.match(m.LIVE_DEFAULT, /\.config\/opencode\/opencode\.jsonc$/);
});

