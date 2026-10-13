#!/usr/bin/env node
/**
 * test-validate-config-fleet.cjs
 *
 * Fixture tests for validate-config.cjs's `checkAgentFleet` — the discovered
 * fleet model-pin check. Pure: the helper takes the filename list and a reader,
 * so these fixtures never touch the real agents dir.
 *
 * Pins the fail-closed contract of the n=30 next-hypothesis (b) change: the
 * check must (1) cover every discovered agent, not a fixed table, so a new
 * agent with a dated-id or absent pin is caught with no table edit; (2) still
 * assert the exact tier where EXPECTED_MODELS fixes one; and (3) treat a table
 * entry with no backing file as a stale contract, not a silent drop.
 *
 * Run: node --test install/lib/test-validate-config-fleet.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkAgentFleet, EXPECTED_MODELS, parseFrontmatter } = require('./validate-config.cjs');

const fm = (model) => `---\ndescription: x\nmode: subagent\nmodel: ${model}\nsteps: 5\n---\n\nbody\n`;

/**
 * A baseline where every table-pinned agent is present with its declared tier,
 * so a test can perturb exactly one file and attribute the errors to it.
 */
function baseline(overrides = {}) {
  const files = {};
  for (const [name, model] of Object.entries(EXPECTED_MODELS)) files[name] = fm(model);
  Object.assign(files, overrides);
  return files;
}

/** Reader over an in-memory filename -> markdown map. */
function reader(files) {
  return (name) => {
    if (!(name in files)) throw new Error(`unexpected read: ${name}`);
    return files[name];
  };
}

// ─── Discovery: a new agent is covered without a table edit ──────────────────

test('a discovered agent with a dated-id pin is rejected even if not in the table', () => {
  const files = baseline({ 'brand-new.md': fm('synthetic/hf:moonshotai/Kimi-K3') });
  const names = [...Object.keys(EXPECTED_MODELS), 'brand-new.md'];
  const { errors, lines } = checkAgentFleet(names, reader(files));
  assert.deepEqual(errors, ['brand-new.md model is not an established alias']);
  assert.ok(lines.some((l) => l.includes('✗') && l.includes('brand-new.md')));
});

test('a discovered agent with an absent pin is rejected', () => {
  const files = baseline({ 'brand-new.md': '---\ndescription: x\nmode: subagent\n---\n\nbody\n' });
  const names = [...Object.keys(EXPECTED_MODELS), 'brand-new.md'];
  const { errors } = checkAgentFleet(names, reader(files));
  assert.deepEqual(errors, ['brand-new.md model is not an established alias']);
});

test('a discovered agent with a valid alias and no table entry passes', () => {
  const files = baseline({ 'brand-new.md': fm('synthetic/syn:small:text') });
  const names = [...Object.keys(EXPECTED_MODELS), 'brand-new.md'];
  const { errors, lines } = checkAgentFleet(names, reader(files));
  assert.deepEqual(errors, []);
  assert.ok(lines.some((l) => l.includes('✓') && l.includes('brand-new.md')));
});

// ─── Exact tier assertion where the table fixes one ──────────────────────────

test('a table-pinned agent with the wrong tier is rejected', () => {
  // reviewer is table-pinned to large; give it small.
  const files = baseline({ 'reviewer.md': fm('synthetic/syn:small:text') });
  const { errors } = checkAgentFleet(Object.keys(EXPECTED_MODELS), reader(files));
  assert.deepEqual(errors, ['reviewer.md model mismatch']);
});

test('a table-pinned agent with the right tier passes', () => {
  const files = baseline();
  const { errors } = checkAgentFleet(Object.keys(EXPECTED_MODELS), reader(files));
  assert.deepEqual(errors, []);
});

// ─── A table entry with no backing file is a stale contract ──────────────────

test('an EXPECTED_MODELS entry with no discovered file is an error', () => {
  const files = baseline();
  const names = Object.keys(EXPECTED_MODELS).filter((n) => n !== 'reviewer.md');
  const { errors } = checkAgentFleet(names, reader(files));
  assert.ok(errors.includes('reviewer.md missing'));
  assert.equal(errors.length, 1, 'only the omitted table entry is flagged');
});

// ─── Missing frontmatter fails closed ────────────────────────────────────────

test('an agent with no frontmatter is rejected', () => {
  const files = baseline({ 'broken.md': 'no frontmatter here\n' });
  const names = [...Object.keys(EXPECTED_MODELS), 'broken.md'];
  const { errors } = checkAgentFleet(names, reader(files));
  assert.deepEqual(errors, ['broken.md missing frontmatter']);
});

// ─── A discovered file the reader cannot read fails closed, not throws ───────

test('a discovered file that cannot be read is an error, not a throw', () => {
  const files = baseline();
  const names = [...Object.keys(EXPECTED_MODELS), 'unreadable.md'];
  const base = reader(files);
  const r = (name) => {
    if (name === 'unreadable.md') throw new Error('EACCES');
    return base(name);
  };
  let result;
  assert.doesNotThrow(() => { result = checkAgentFleet(names, r); });
  assert.deepEqual(result.errors, ['unreadable.md unreadable']);
  assert.ok(result.lines.some((l) => l.includes('✗') && l.includes('unreadable.md')));
});

// ─── parseFrontmatter is exported for the helper's own fixtures ──────────────

test('parseFrontmatter is exported and parses the model line', () => {
  assert.equal(parseFrontmatter(fm('synthetic/syn:large:text')).model, 'synthetic/syn:large:text');
});
