#!/usr/bin/env node
/**
 * test-validate-config-coherence.cjs
 *
 * Fixture tests for validate-config.cjs's `checkPermissionCoherence` (RSI n=43).
 * Pure: the predicate takes the parsed `permissions` array, so these fixtures
 * never read the real overlay (except the positive control at the end).
 *
 * The host is silent about two inertness classes the `effect` VALUE check
 * (n=41) does not cover:
 *
 *   - ACTION vocabulary. A V2 rule's `action` decodes as a free
 *     `Schema.String` (packages/schema/src/permission.ts:27, no enum) and is
 *     matched verbatim by glob under `findLast`
 *     (packages/core/src/permission.ts:87-93). The host rewrites V1 action
 *     names ONLY for the legacy `permission:`/`tools` keys
 *     (packages/core/src/config/normalize.ts:179-182 via
 *     `ConfigMigrateV1.normalizeAction`, packages/core/src/v1/config/migrate.ts:117-122:
 *     write|patch -> edit, task -> subagent, bash -> shell). A V2 `permissions`
 *     array entry is decoded VERBATIM, so `action: "bash"` is inert.
 *
 *   - ACTION/RESOURCE plane. `expandHome` runs only for the path actions
 *     `external_directory|read|edit` (packages/core/src/config/plugin/agent.ts:31,
 *     `isPathAction`), so `~`/`$HOME` on any other action never matches a path;
 *     and a path action whose `resource` is a shell command never matches one.
 *
 * Run: node --test install/lib/test-validate-config-coherence.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkPermissionCoherence,
  checkPermissionEffects,
  HOST_PERMISSION_ACTIONS,
  PATH_ACTIONS,
  KNOWN_EFFECTS,
} = require('./validate-config.cjs');
const { KNOWN_ACTIONS } = require('./validate-agents.cjs');

// ─── Vocabulary ───────────────────────────────────────────────────────────────

test('HOST_PERMISSION_ACTIONS matches the agent plane\'s KNOWN_ACTIONS', () => {
  // Both planes decode the same `Permission.Rule` (packages/schema/src/permission.ts),
  // so the accepted action set must be identical. If one is edited the other
  // must move with it, or the two planes disagree about what the host emits.
  assert.deepEqual(
    [...HOST_PERMISSION_ACTIONS].sort(),
    [...KNOWN_ACTIONS].sort(),
  );
});

test('PATH_ACTIONS is exactly the host isPathAction set', () => {
  // packages/core/src/config/plugin/agent.ts:31
  assert.deepEqual([...PATH_ACTIONS].sort(), ['edit', 'external_directory', 'read']);
});

test('a V1 action name is rejected (the host matches the V2 action verbatim)', () => {
  for (const v1 of ['bash', 'task', 'write', 'patch']) {
    const r = checkPermissionCoherence([{ action: v1, resource: '*', effect: 'deny' }]);
    assert.equal(r.errors.length, 1, `action '${v1}' must be rejected`);
    assert.ok(r.errors[0].includes(`'${v1}'`), JSON.stringify(r.errors));
    assert.ok(r.lines.some((l) => l.includes('✗') && l.includes('inert')));
  }
});

test('an unimplemented action string is rejected', () => {
  const r = checkPermissionCoherence([{ action: 'teleport', resource: '*', effect: 'allow' }]);
  assert.equal(r.errors.length, 1);
  assert.ok(/permissions\[0\]\.action is 'teleport'/.test(r.errors[0]), JSON.stringify(r.errors));
});

test('every host action is accepted', () => {
  for (const action of HOST_PERMISSION_ACTIONS) {
    const r = checkPermissionCoherence([{ action, resource: '*', effect: 'allow' }]);
    assert.deepEqual(r.errors, [], `action '${action}' must be accepted`);
  }
});

// ─── Action/resource plane ────────────────────────────────────────────────────

test('a home-token resource on a non-path action is rejected', () => {
  // expandHome runs only for read/edit/external_directory, so the host never
  // expands this on a shell rule.
  for (const res of ['~/.ssh/**', '~/private', '$HOME/secret', '$HOME/x/**']) {
    const r = checkPermissionCoherence([{ action: 'shell', resource: res, effect: 'deny' }]);
    assert.equal(r.errors.length, 1, `resource '${res}' must be rejected on shell`);
    assert.ok(r.errors[0].includes('home-token'), JSON.stringify(r.errors));
  }
});

test('a command resource on a path action is rejected', () => {
  for (const action of ['read', 'edit', 'external_directory']) {
    const r = checkPermissionCoherence([{ action, resource: 'rm -rf *', effect: 'deny' }]);
    assert.equal(r.errors.length, 1, `command resource must be rejected on '${action}'`);
    assert.ok(r.errors[0].includes('command resource'), JSON.stringify(r.errors));
  }
});

test('a home-token resource on a path action is accepted (the host expands it)', () => {
  for (const action of PATH_ACTIONS) {
    const r = checkPermissionCoherence([{ action, resource: '~/.config/opencode/**', effect: 'allow' }]);
    assert.deepEqual(r.errors, [], `home resource must be accepted on '${action}'`);
  }
});

test('a command resource on a non-path action is accepted', () => {
  const r = checkPermissionCoherence([{ action: 'shell', resource: 'git push --force *', effect: 'deny' }]);
  assert.deepEqual(r.errors, []);
});

// ─── Resource classes the shipped overlay actually uses ───────────────────────

test('the overlay\'s resource classes are all accepted', () => {
  const cases = [
    { action: 'shell', resource: 'git status *', effect: 'allow' },
    { action: 'shell', resource: 'git push * +*', effect: 'deny' },
    { action: 'shell', resource: 'dd *of=/dev/*', effect: 'ask' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'read', resource: '*.env', effect: 'deny' },
    { action: 'read', resource: '*id_rsa.*', effect: 'deny' },
    { action: 'read', resource: '*.kube/config*', effect: 'deny' },
    { action: 'edit', resource: '~/.config/opencode/**', effect: 'deny' },
    { action: 'edit', resource: 'opencode.json*', effect: 'deny' },
    { action: 'edit', resource: '.opencode/**', effect: 'deny' },
    { action: 'external_directory', resource: '~/.config/opencode/style/**', effect: 'allow' },
  ];
  for (const rule of cases) {
    const r = checkPermissionCoherence([rule]);
    assert.deepEqual(r.errors, [], `${JSON.stringify(rule)} must be accepted`);
  }
});

// ─── Fail-closed / silent contract ────────────────────────────────────────────

test('a missing or non-string action fails', () => {
  for (const bad of [undefined, null, 5, {}, []]) {
    const r = checkPermissionCoherence([{ resource: '*', effect: 'allow', action: bad }]);
    assert.equal(r.errors.length, 1, `action ${JSON.stringify(bad)} must fail`);
    assert.ok(/permissions\[0\]\.action is missing or not a string/.test(r.errors[0]));
  }
});

test('a missing or non-string resource fails', () => {
  for (const bad of [undefined, null, 5, {}]) {
    const r = checkPermissionCoherence([{ action: 'read', effect: 'allow', resource: bad }]);
    assert.equal(r.errors.length, 1, `resource ${JSON.stringify(bad)} must fail`);
    assert.ok(/permissions\[0\]\.resource is missing or not a string/.test(r.errors[0]));
  }
});

test('a non-object element is silent (checkPermissionEffects owns that report)', () => {
  for (const bad of ['read', 5, null, ['read', '*']]) {
    const r = checkPermissionCoherence([bad]);
    assert.deepEqual(r.errors, [], `element ${JSON.stringify(bad)} must be silent here`);
    assert.equal(r.rules, 1);
  }
});

test('a non-array input yields no errors (presence is the caller\'s check)', () => {
  for (const bad of [undefined, null, {}, 'x', 3]) {
    const r = checkPermissionCoherence(bad);
    assert.deepEqual(r.errors, []);
    assert.equal(r.rules, 0);
  }
});

test('an empty array is valid and silent', () => {
  const r = checkPermissionCoherence([]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lines, []);
  assert.equal(r.rules, 0);
});

test('the offending element is named by index in a mixed array', () => {
  const r = checkPermissionCoherence([
    { action: 'read', resource: '*.env', effect: 'deny' },
    { action: 'bash', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '~/.ssh/**', effect: 'deny' },
  ]);
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.some((e) => e.includes('permissions[1]')), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => e.includes('permissions[2]')), JSON.stringify(r.errors));
});

test('a bad effect is NOT this predicate\'s report (no double-reporting)', () => {
  // effect VALUE is checkPermissionEffects's axis; this predicate must stay
  // silent about it even when the action/resource are coherent.
  const r = checkPermissionCoherence([{ action: 'read', resource: '*.env', effect: 'alow' }]);
  assert.deepEqual(r.errors, [], 'a bad effect must not be reported here');
  // And the converse: the effect check DOES report it, so the two gates are
  // disjoint and neither can be dropped without a red build.
  const e = checkPermissionEffects([{ action: 'read', resource: '*.env', effect: 'alow' }]);
  assert.equal(e.errors.length, 1, 'checkPermissionEffects owns the bad effect');
  // A bad effect is not a valid effect value, confirming the sets are separate.
  assert.equal(KNOWN_EFFECTS.has('alow'), false, 'alow is not a known effect');
});

// ─── Positive control: the shipped overlay ────────────────────────────────────

test('the real overlay permission rules are all coherent', () => {
  const fs = require('fs');
  const path = require('path');
  const { stripJsonc } = require('./validate-config.cjs');
  const cfg = path.resolve(__dirname, '..', 'opencode', 'config.jsonc');
  const parsed = JSON.parse(stripJsonc(fs.readFileSync(cfg, 'utf8')));
  const r = checkPermissionCoherence(parsed.permissions);
  assert.deepEqual(r.errors, [], `real overlay must be clean, got: ${JSON.stringify(r.errors)}`);
  assert.ok(r.rules > 0, 'the real overlay declares permission rules');
});
