#!/usr/bin/env node
/**
 * test-agent-model-pin.cjs
 *
 * Fixture tests for agent-model-pin.cjs. Pure predicate; never reads $HOME or
 * the live config. Pins the fail-closed contract that a fleet agent's `model:`
 * must be one of the four established synthetic aliases, so a dated-id re-pin
 * (the golden-n1 3b42eee regression) cannot silently ship, and so the guard
 * cannot widen to `syn:auto` or an arbitrary `syn:<word>` shape.
 *
 * Run: node --test install/lib/test-agent-model-pin.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { SYNTHETIC_ALIASES, isSyntheticAlias, checkAgentModel } =
  require('./agent-model-pin.cjs');

// ─── Positive control: the four published aliases ────────────────────────────

test('accepts all four established aliases', () => {
  for (const alias of [
    'synthetic/syn:large:text',
    'synthetic/syn:small:text',
    'synthetic/syn:large:vision',
    'synthetic/syn:small:vision',
  ]) {
    assert.equal(isSyntheticAlias(alias), true, `${alias} is an alias`);
    assert.deepEqual(checkAgentModel('executor.md', alias).errors, []);
  }
  assert.equal(SYNTHETIC_ALIASES.size, 4);
});

// ─── The motivating defect: dated model ids ──────────────────────────────────

test('rejects dated hf: model ids (the 3b42eee regression)', () => {
  for (const dated of [
    'synthetic/hf:moonshotai/Kimi-K3',
    'synthetic/hf:moonshotai/Kimi-K2.7-Code',
    'synthetic/hf:openai/gpt-5',
  ]) {
    assert.equal(isSyntheticAlias(dated), false, `${dated} is not an alias`);
    const { errors, lines } = checkAgentModel('reviewer.md', dated);
    assert.equal(errors.length, 1);
    assert.ok(lines[0].includes('✗'));
  }
});

// ─── The reach gap must not be admitted by a shape match ─────────────────────

test('rejects syn:auto (unrouted) and shape-only lookalikes', () => {
  for (const bad of [
    'synthetic/syn:auto',
    'synthetic/syn:large',
    'synthetic/syn:foo',
    'synthetic/syn:large:audio',
    'synthetic/syn:large:text:extra',
  ]) {
    assert.equal(isSyntheticAlias(bad), false, `${bad} is not a valid alias`);
    assert.equal(checkAgentModel('executor.md', bad).errors.length, 1);
  }
});

// ─── Absent / non-string pins fail closed ────────────────────────────────────

test('an absent or non-string model is an error', () => {
  for (const absent of [undefined, null, '', 42]) {
    const { errors } = checkAgentModel('executor.md', absent);
    assert.equal(errors.length, 1, `${String(absent)} is rejected`);
  }
});
