#!/usr/bin/env node
/**
 * test-validate-agents-actions.cjs
 *
 * Fixture tests for validate-agents.cjs's permission-action classification
 * (RSI n=37). Pure: `validateAgent` and `permissionActions` take text, so these
 * fixtures never touch the real agents dir.
 *
 * Pins the fail-closed contract: the host accepts any permission `action`
 * string and silently never matches an unknown one (Schema.String, no enum, at
 * packages/schema/src/permission.ts:58-64; the frontmatter decode drops an agent
 * only on an ENUM failure, packages/core/src/config/plugin/agent.ts:26,36-41;
 * `findLast` at packages/core/src/permission.ts:76-84). An inert rule must fail
 * the build, not ship.
 *
 * Run: node --test install/lib/test-validate-agents-actions.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateAgent, permissionActions, KNOWN_ACTIONS, KNOWN_EFFECTS } = require('./validate-agents.cjs');

/** A minimal valid agent whose permissions block is `rules`. */
function agent(rules) {
  return [
    '---',
    'description: x',
    'mode: subagent',
    'steps: 5',
    'permissions:',
    ...rules,
    '---',
    '',
    'body',
    '',
  ].join('\n');
}

/** One canonical rule. */
function rule(action, resource = '*', effect = 'allow') {
  return [`  - action: ${action}`, `    resource: "${resource}"`, `    effect: ${effect}`];
}

test('a typoed action fails the gate', () => {
  const errs = validateAgent('x.md', agent(rule('subagnt')));
  assert.ok(errs.some((e) => /unknown permission action/.test(e) && /subagnt/.test(e)),
    `expected an unknown-action error, got: ${JSON.stringify(errs)}`);
});

test('every real fleet action passes', () => {
  // The actions the six shipped agents declare. `external_directory` carries its
  // canonical style resource, and `*` is the broad-deny wildcard.
  const cases = [
    ['*', '*'], ['edit', '*'], ['subagent', '*'], ['webfetch', '*'],
    ['websearch', '*'], ['glob', '*'], ['grep', '*'], ['question', '*'],
    ['read', '*'], ['external_directory', '~/.config/opencode/style/**'],
  ];
  for (const [a, res] of cases) {
    // A style grant additionally requires a coding-style.md reference in the body.
    const body = res === '~/.config/opencode/style/**' ? 'See coding-style.md.' : 'body';
    const text = agent(rule(a, res)).replace('\nbody\n', `\n${body}\n`);
    const errs = validateAgent('x.md', text);
    assert.deepEqual(errs, [], `action '${a}' should be accepted, got: ${JSON.stringify(errs)}`);
  }
});

test('the whole shipped fleet passes with no action errors', () => {
  const dir = path.resolve(__dirname, '..', 'opencode', 'agents');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const errs = validateAgent(f, fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(errs, [], `${f} should be clean, got: ${JSON.stringify(errs)}`);
  }
});

test('an unclassified action fails', () => {
  const errs = validateAgent('x.md', agent(rule('teleport')));
  assert.ok(errs.some((e) => /unknown permission action/.test(e) && /teleport/.test(e)));
});

test('a rule with no effect fails', () => {
  const errs = validateAgent('x.md', agent(['  - action: read', '    resource: "*"']));
  assert.ok(errs.some((e) => /no 'effect'/.test(e)), JSON.stringify(errs));
});

test('a rule with no action fails', () => {
  const errs = validateAgent('x.md', agent(['  - resource: "*"', '    effect: allow']));
  assert.ok(errs.some((e) => /no 'action'/.test(e)), JSON.stringify(errs));
});

test('the check is scoped to the permissions block, not prose', () => {
  // A body sentence mentioning an "action:" must not be read as a rule.
  const text = [
    '---',
    'description: x',
    'mode: subagent',
    'steps: 5',
    'permissions:',
    ...rule('read'),
    '---',
    '',
    'Body prose: an action: teleport would be unknown, but this is not a rule.',
    'Another action: nonsense line.',
    '',
  ].join('\n');
  const errs = validateAgent('x.md', text);
  assert.deepEqual(errs, [], `prose must not be scanned, got: ${JSON.stringify(errs)}`);
  assert.equal(permissionActions(text).rules, 1);
});

test('the wildcard action is known', () => {
  assert.ok(KNOWN_ACTIONS.has('*'));
  assert.deepEqual(validateAgent('x.md', agent(rule('*', '*', 'deny'))), []);
});

test('legacy v1-only spellings are rejected as inert in the v2 permissions array', () => {
  // `qf()` normalizes write|patch -> edit and task -> subagent and bash -> shell
  // only for the legacy `permission:` object form. The v2 `permissions:` ARRAY
  // (and agent frontmatter permissions) decodes the action verbatim, so a rule
  // `action: bash` never matches the runtime `shell` and is inert — exactly the
  // class this gate rejects.
  for (const a of ['bash', 'task', 'write', 'patch']) {
    assert.ok(!KNOWN_ACTIONS.has(a), `${a} must NOT be accepted (inert in v2)`);
    const errs = validateAgent('x.md', agent(rule(a)));
    assert.ok(errs.some((e) => /unknown permission action/.test(e) && e.includes(a)),
      `${a} must fail, got: ${JSON.stringify(errs)}`);
  }
});

test('permissionActions counts rules and flags unknown ones', () => {
  const text = agent([...rule('read'), ...rule('edit'), ...rule('bogus')]);
  const r = permissionActions(text);
  assert.equal(r.rules, 3);
  assert.deepEqual(r.unknown, ['bogus']);
  assert.equal(r.missingAction, 0);
  assert.equal(r.missingEffect, 0);
  assert.equal(r.unscanned, 0);
});

// ─── Effect VALUE (n=41) ─────────────────────────────────────────────────────
// The host decodes `effect` as Schema.Literals(["allow","deny","ask"])
// (packages/schema/src/permission.ts:54). An invalid value fails the agent
// decode (decodeUnknownOption + errors:"all"), which silently DROPS THE WHOLE
// AGENT (binary oracle: `opencode debug agents` omits an agent whose rule reads
// `effect: alow`). n=37 checked only presence; these fixtures pin the value.

test('every real fleet effect value is accepted', () => {
  const dir = path.resolve(__dirname, '..', 'opencode', 'agents');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const r = permissionActions(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(r.badEffect, [], `${f} must carry only valid effects, got: ${JSON.stringify(r.badEffect)}`);
  }
});

test('KNOWN_EFFECTS is exactly the host literal set', () => {
  assert.deepEqual([...KNOWN_EFFECTS].sort(), ['allow', 'ask', 'deny']);
});

test('a mistyped effect value fails the gate (the whole agent would be dropped)', () => {
  for (const bad of ['alow', 'Allow', 'ALLOW', 'denyy', 'tru', 'yes']) {
    const errs = validateAgent('x.md', agent(rule('read', '*', bad)));
    assert.ok(errs.some((e) => /invalid permission effect/.test(e) && e.includes(bad)),
      `effect '${bad}' must fail, got: ${JSON.stringify(errs)}`);
  }
});

test('a quoted effect whose value is valid passes', () => {
  // normVal strips surrounding quotes, so `effect: "allow"` is the value `allow`.
  const errs = validateAgent('x.md', agent(['  - action: read', '    resource: "*"', '    effect: "allow"']));
  assert.deepEqual(errs, [], JSON.stringify(errs));
});

test('a numeric bare effect fails (not coerced to a valid one)', () => {
  const errs = validateAgent('x.md', agent(['  - action: read', '    resource: "*"', '    effect: 1']));
  assert.ok(errs.some((e) => /invalid permission effect/.test(e)), JSON.stringify(errs));
});

test('permissionActions reports bad effects separately from missing ones', () => {
  const text = agent([...rule('read', '*', 'deny'), ...rule('edit', '*', 'nope')]);
  const r = permissionActions(text);
  assert.deepEqual(r.badEffect, ['nope']);
  assert.equal(r.missingEffect, 0);
});

test('an unstructured-action spelling fails closed, not skipped', () => {
  // A rule whose action sits off the canonical "- action:" line cannot be
  // classified. It must be an error (missing action/effect here), never a pass.
  const text = agent(['  - { action: read, resource: "*", effect: allow }']);
  const errs = validateAgent('x.md', text);
  assert.ok(errs.length > 0, `expected an error, got none for ${JSON.stringify(permissionActions(text))}`);
  const r = permissionActions(text);
  assert.ok(r.missingAction > 0 || r.unscanned > 0,
    `a flow-style rule must be flagged, got ${JSON.stringify(r)}`);
});
