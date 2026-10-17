#!/usr/bin/env node
/**
 * test-validate-config-effects.cjs
 *
 * Fixture tests for validate-config.cjs's `checkPermissionEffects` (RSI n=41).
 * Pure: the predicate takes the parsed `permissions` array, so these fixtures
 * never read the real overlay.
 *
 * Pins the fail-closed contract for the config permission plane. The host
 * decodes each rule's `effect` as Schema.Literals(["allow","deny","ask"])
 * (packages/schema/src/permission.ts:54) and decodes `Config.Info` with
 * `decodeUnknownOption(..., { errors: "all", onExcessProperty: "ignore" })`
 * (packages/core/src/config.ts:144). An element whose `effect` is outside the
 * set is dropped from the array while the document survives (binary oracle:
 * a three-rule array `allow`/`alow`/`deny` decodes to two rules, exit 0, no
 * warning) — a permission gate that silently stops gating. An invalid effect
 * must fail the build, not ship.
 *
 * Run: node --test install/lib/test-validate-config-effects.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkPermissionEffects, KNOWN_EFFECTS } = require('./validate-config.cjs');

test('KNOWN_EFFECTS is exactly the host literal set', () => {
  assert.deepEqual([...KNOWN_EFFECTS].sort(), ['allow', 'ask', 'deny']);
});

test('accepts the three valid effects', () => {
  for (const effect of ['allow', 'deny', 'ask']) {
    const r = checkPermissionEffects([{ action: 'read', resource: '*', effect }]);
    assert.deepEqual(r.errors, [], `effect '${effect}' must be accepted`);
    assert.equal(r.rules, 1);
    assert.ok(r.lines.some((l) => l.includes('✓')), 'a passing array prints a ✓ line');
  }
});

test('rejects a mistyped effect value (the host would silently drop the rule)', () => {
  const r = checkPermissionEffects([{ action: 'read', resource: '*.a', effect: 'alow' }]);
  assert.equal(r.errors.length, 1);
  assert.ok(/permissions\[0\]\.effect is 'alow'/.test(r.errors[0]), JSON.stringify(r.errors));
  assert.ok(r.lines.some((l) => l.includes('✗') && l.includes('silently drops')));
});

test('flags the offending element by index in a mixed array', () => {
  const r = checkPermissionEffects([
    { action: 'read', resource: '*.a', effect: 'allow' },
    { action: 'read', resource: '*.b', effect: 'alow' },
    { action: 'read', resource: '*.c', effect: 'deny' },
  ]);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes('permissions[1]'), JSON.stringify(r.errors));
});

test('case-variant effects are rejected (the literal set is exact)', () => {
  for (const bad of ['Allow', 'ALLOW', 'DENY', 'Ask']) {
    const r = checkPermissionEffects([{ action: 'read', resource: '*', effect: bad }]);
    assert.equal(r.errors.length, 1, `effect '${bad}' must fail`);
  }
});

test('a missing effect fails', () => {
  const r = checkPermissionEffects([{ action: 'read', resource: '*' }]);
  assert.equal(r.errors.length, 1);
  assert.ok(/permissions\[0\]\.effect is missing or not a string/.test(r.errors[0]), JSON.stringify(r.errors));
});

test('a non-string effect fails', () => {
  for (const bad of [1, true, null, {}, []]) {
    const r = checkPermissionEffects([{ action: 'read', resource: '*', effect: bad }]);
    assert.equal(r.errors.length, 1, `effect ${JSON.stringify(bad)} must fail`);
  }
});

test('a non-object rule element fails', () => {
  for (const bad of ['read', 5, null, ['read', '*']]) {
    const r = checkPermissionEffects([bad]);
    assert.equal(r.errors.length, 1, `rule ${JSON.stringify(bad)} must fail`);
    assert.ok(/permissions\[0\] is not an object/.test(r.errors[0]));
  }
});

test('a non-array input yields no errors (presence is the caller\'s check)', () => {
  // validate-config already fails closed when `permissions` is not an array;
  // this predicate stays silent so the two checks do not double-report.
  for (const bad of [undefined, null, {}, 'x', 3]) {
    const r = checkPermissionEffects(bad);
    assert.deepEqual(r.errors, []);
    assert.equal(r.rules, 0);
  }
});

test('an empty array is valid and silent', () => {
  const r = checkPermissionEffects([]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rules, 0);
  assert.deepEqual(r.lines, []);
});

test('the real overlay permission effects are all valid', () => {
  // Positive control: read the shipped overlay and run the predicate on it.
  const fs = require('fs');
  const path = require('path');
  const { stripJsonc } = require('./validate-config.cjs');
  const cfg = path.resolve(__dirname, '..', 'opencode', 'config.jsonc');
  const parsed = JSON.parse(stripJsonc(fs.readFileSync(cfg, 'utf8')));
  const r = checkPermissionEffects(parsed.permissions);
  assert.deepEqual(r.errors, [], `real overlay must be clean, got: ${JSON.stringify(r.errors)}`);
  assert.ok(r.rules > 0, 'the real overlay declares permission rules');
});
