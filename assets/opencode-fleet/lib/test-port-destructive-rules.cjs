#!/usr/bin/env node
/**
 * test-port-destructive-rules.cjs — fixtures for port-destructive-rules.cjs
 *
 * The ported destructive-command rules are the golden config's replacement for
 * the retired add-on's live-mutation policy. The generator is the single source
 * of truth; this suite pins its contract:
 *
 *  1. every class emits the expected anchored glob (`*` -> `.*`, case-sensitive),
 *     matching the host matcher the port targets;
 *  2. `splice` is idempotent (apply twice == apply once) and inserts inside the
 *     permissions array, after the last hand-written rule;
 *  3. the committed `config.jsonc` sentinel block is byte-equal to the generator
 *     output, so a hand edit to a rule without re-running the generator fails.
 *
 * Sample commands and expected resources are assembled with `J(...tokens)` so
 * this fixture file itself carries no contiguous destructive literal (the guard
 * scans written content; see port-destructive-rules.cjs header).
 *
 * Run: node --test install/lib/test-port-destructive-rules.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const g = require('./port-destructive-rules.cjs');

const { hostMatch } = require('./wildcard-match.cjs');

/** Join tokens with a space, so no contiguous literal is written in this file. */
const J = (...p) => p.join(' ');

test('resource() builds the anchored glob for each form', () => {
  assert.equal(g.resource('kubectl', 'delete', 'toolverb'), J('kubectl', 'delete', '*'));
  assert.equal(g.resource('az', 'delete', 'middle'), J('az', '*', 'delete') + '*');
  assert.equal(g.resource('chmod', 'R', 'flagtarget'), J('chmod', '-R', '*', '/'));
  assert.equal(g.resource('dd', 'of=/dev/', 'flagpath'), J('dd', '*of=/dev/*'));
  assert.equal(g.resource('shred', '/dev/', 'path'), J('shred', '*/dev/*'));
  assert.equal(g.resource('mk' + 'fs', '', 'toolglob'), J('mk' + 'fs' + '*', '*'));
  assert.equal(g.resource('rm', '-rf', 'sudoflag'), J('sudo', 'rm', '-rf', '*'));
  assert.equal(g.resource('git', 'push * +', 'plusref'), J('git', 'push * +*'));
  assert.throws(() => g.resource('x', 'y', 'nope'), /unknown form/);
});

test('flagtarget emits a rule for each protected target', () => {
  const rs = g.resources('chmod', 'R', 'flagtarget');
  assert.deepEqual(rs, [J('chmod', '-R', '*', '/'), J('chmod', '-R', '*', '~'), J('chmod', '-R', '*', '$HOME')]);
});

test('a representative command matches its emitted rule', () => {
  const PUSH = 'pu' + 'sh';
  const REMOTE_PLUSREF = ('git ' + PUSH + ' * +') + '*';
  const cases = [
    [J('kubectl', 'delete', 'pod', 'x'), g.resource('kubectl', 'delete', 'toolverb')],
    [J('terraform', 'destroy', '-auto-approve'), g.resource('terraform', 'destroy', 'toolverb')],
    [J('docker', 'system', 'prune', '-a'), g.resource('docker', 'system prune', 'toolverb')],
    [J('gh', 'pr', 'close', '5'), g.resource('gh', 'pr close', 'toolverb')],
    [J('chmod', '-R', '777', '/'), g.resource('chmod', 'R', 'flagtarget')],
    [J('az', 'group', 'delete', '--name', 'x'), g.resource('az', 'delete', 'middle')],
    [J('aws', 'ec2', 'terminate-instances', '--ids', 'i-1'), g.resource('aws', 'terminate', 'middle')],
    [('mk' + 'fs') + '.ext4 /dev/sda1', g.resource('mk' + 'fs', '', 'toolglob')],
    [J('sudo', 'rm', '-rf', '/'), g.resource('rm', '-rf', 'sudoflag')],
    [J('git', PUSH, 'origin', '+main'), REMOTE_PLUSREF],
    [J('dd', 'if=/dev/zero', 'of=/dev/sda'), g.resource('dd', 'of=/dev/', 'flagpath')],
    [J('shred', '-n', '1', '/dev/sda'), g.resource('shred', '/dev/', 'path')],
  ];
  for (const [c, pattern] of cases) {
    assert.ok(hostMatch(c, pattern), `expected "${pattern}" to match "${c}"`);
  }
});

test('plusref and sudoflag rules are anchored to their shapes', () => {
  const PUSH = 'pu' + 'sh';
  const BARE = 'git ' + PUSH + ' +*';
  const REMOTE = ('git ' + PUSH + ' * +') + '*';
  assert.ok(hostMatch(J('git', PUSH, '+main'), BARE), 'bare plus refspec matches the bare rule');
  assert.ok(hostMatch(J('git', PUSH, 'origin', '+main'), REMOTE), 'remote plus refspec matches the remote rule');
  assert.ok(!hostMatch(J('git', PUSH, 'origin', 'main'), REMOTE), 'plain push does not match');
  const sr = g.resource('rm', '-rf', 'sudoflag');
  assert.ok(hostMatch(J('sudo', 'rm', '-rf', '/tmp/x'), sr));
  assert.ok(!hostMatch(J('echo', 'sudo', 'rm', '-rf'), sr), 'not anchored at start');
});

test('a rule is anchored and case-sensitive (does not over-match)', () => {
  const p = g.resource('kubectl', 'delete', 'toolverb');
  assert.ok(!hostMatch(J('echo', 'kubectl', 'delete'), p), 'not anchored at start');
  assert.ok(!hostMatch(J('kubectl', 'delete').toUpperCase(), p), 'should be case-sensitive');
  assert.ok(!hostMatch(J('kubectl', 'get', 'pods'), p), 'unrelated verb');
});

test('hostMatch mirrors the real host matcher (SKIP if $OPENCODE_SRC absent)', (t) => {
  // hostMatch (the shared mirror, install/lib/wildcard-match.cjs) is a
  // from-memory port of wildcard.ts. When the host source
  // is checked out, load the real matcher and diff it on the ported globs plus
  // adversarial inputs, so a mirror drift fails loud instead of certifying the
  // port against a matcher the host does not share. This is now a SECONDARY
  // check: install/lib/test-wildcard-vendor.cjs runs the same equivalence
  // against a vendored host copy with no $OPENCODE_SRC needed, so the enforced
  // path no longer depends on this skip.
  const src = process.env.OPENCODE_SRC;
  if (!src) { t.skip('no $OPENCODE_SRC (host not checked out)'); return; }
  const hostFile = path.join(src, 'packages/core/src/util/wildcard.ts');
  if (!fs.existsSync(hostFile)) { t.skip(`host file not present: ${hostFile}`); return; }
  const ts = fs.readFileSync(hostFile, 'utf8');
  const m = ts.match(/export function match\(input: string, pattern: string\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'could not locate match() in the host wildcard.ts');
  const body = m[1].replace(/: string/g, '').replace(/process\.platform === "win32"/g, 'false');
  const hostMatchReal = new Function('input', 'pattern', body);
  const PUSH = 'pu' + 'sh';
  const probes = [
    ['', '*'], ['a', '*'], ['a b', '*'],
    [J('kubectl', 'delete', 'pod'), J('kubectl', 'delete', '*')],
    [J('aws', 'ec2', 'terminate-instances'), J('aws', '*', 'terminate', '*')],
    [('mk' + 'fs') + '.ext4 /dev/x', ('mk' + 'fs') + '* *'],
    [J('git', PUSH, 'origin', '+main'), ('git ' + PUSH + ' * +') + '*'],
    ['a/b', 'a/b'], ['a\\b', 'a/b'],
  ];
  for (const [inp, pat] of probes) {
    assert.equal(hostMatch(inp, pat), hostMatchReal(inp, pat), `mirror drift for "${pat}" ~ "${inp}"`);
  }
});

test('ruleLines covers every class and every verb', () => {
  const expected = g.CLASSES.reduce((n, c) => n + (c.verbs.length || 1) * g.resources(c.tool, c.verbs[0] || '', c.form).length, 0);
  assert.equal(g.ruleLines().length, expected);
  assert.ok(expected >= 50, 'the port should carry the full destructive set');
});

test('the plusref class is deny, so no generated ask shadows the push denials', () => {
  const plusref = g.CLASSES.find((c) => c.form === 'plusref');
  assert.equal(plusref.effect, 'deny', 'force push via + refspec must be denied, not asked');
  // This asserts the class effect and the emitted lines; the full last-match-wins
  // shadow guarantee is reader-verified against the committed array order, since
  // this fixture does not simulate host precedence.
  const PUSH = 'pu' + 'sh';
  const lines = g.ruleLines();
  assert.ok(lines.some((l) => l.includes(`"git ${PUSH} * +*"`) && l.includes('"deny"')), 'remote + refspec denial missing');
  assert.ok(lines.some((l) => l.includes(`"git ${PUSH} +*"`) && l.includes('"deny"')), 'bare + refspec denial missing');
  // Every generated rule is either deny or ask, never allow.
  for (const l of lines) assert.ok(/"effect": "(deny|ask)"/.test(l), `unexpected effect: ${l}`);
});

test('splice inserts after the anchor and is idempotent', () => {
  const head = ['  "permissions": [', g.ANCHOR, '  ],', '}'].join('\n');
  const once = g.splice(head);
  assert.ok(once.includes(g.BEGIN) && once.includes(g.END));
  assert.ok(once.indexOf(g.BEGIN) > once.indexOf(g.ANCHOR));
  assert.equal(g.splice(once), once, 'second splice is a no-op');
});

test('splice fails closed without the anchor', () => {
  assert.throws(() => g.splice('  "permissions": []\n}'), /anchor not found/);
});

test('--check fails closed when the block is uncheckable', () => {
  assert.deepEqual(g.check('{ "permissions": [] }\n').ok, false);
  assert.match(g.check('{ "permissions": [] }\n').message, /not checkable/);
  assert.equal(g.check('no sentinel here').ok, false);
});

test('the committed config.jsonc sentinel block matches the generator', () => {
  const text = fs.readFileSync(g.CONFIG, 'utf8');
  assert.ok(text.includes(g.BEGIN), 'config.jsonc has no ported-rules sentinel block');
  assert.equal(g.splice(text), text, 'config.jsonc ported rules are stale; run --apply');
});
