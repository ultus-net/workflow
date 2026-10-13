#!/usr/bin/env node
/**
 * test-config-shape.cjs
 *
 * Fixture tests for config-shape.cjs. Pure predicate; never reads $HOME or the
 * live config. Pins the fail-closed contract that a renamed, wrong-typed, or
 * unknown sub-key on a cap-bearing key is an error, so the value-shape gate in
 * validate-config.cjs cannot silently start passing a shape it should reject.
 *
 * Run: node --test install/lib/test-config-shape.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { checkConfigShape, checkShapeCoverage } = require('./config-shape.cjs');

// ─── The real overlay's managed-key shapes (positive control) ────────────────

test('accepts the real overlay shapes', () => {
  const parsed = {
    tool_output: { max_lines: 800, max_bytes: 40000 },
    watcher: { ignore: ['**/node_modules/**', '**/dist/**'] },
    compaction: { auto: true, keep: { tokens: 15000 }, buffer: 20000 },
    worktree: { directory: '~/worktrees' },
  };
  const { errors, lines } = checkConfigShape(parsed);
  assert.deepEqual(errors, []);
  assert.ok(lines.every((l) => l.includes('✓')), 'all lines are ✓');
  assert.ok(lines.some((l) => l.includes('tool_output value shape')));
});

test('a key absent from the overlay is not required', () => {
  const { errors } = checkConfigShape({ compaction: { keep: { tokens: 15000 } } });
  assert.deepEqual(errors, []);
});

// ─── Renamed managed sub-key (the motivating defect) ─────────────────────────

test('rejects a renamed managed sub-key: tool_output.max_line', () => {
  const { errors } = checkConfigShape({ tool_output: { max_line: 800, max_bytes: 40000 } });
  assert.equal(errors.length, 2, 'missing max_lines + unknown max_line');
  assert.ok(errors.some((e) => /tool_output\.max_lines is missing/.test(e)));
  assert.ok(errors.some((e) => /tool_output\.max_line is not a declared sub-key/.test(e)));
});

test('rejects a renamed watcher sub-key: watcher.ignored', () => {
  const { errors } = checkConfigShape({ watcher: { ignored: ['**/x/**'] } });
  assert.ok(errors.some((e) => /watcher\.ignore is missing/.test(e)));
  assert.ok(errors.some((e) => /watcher\.ignored is not a declared sub-key/.test(e)));
});

// ─── Wrong-typed values ──────────────────────────────────────────────────────

test('rejects a wrong-typed cap value', () => {
  const { errors } = checkConfigShape({ tool_output: { max_lines: '800', max_bytes: 40000 } });
  assert.ok(errors.some((e) => /tool_output\.max_lines is not a positive integer/.test(e)));
});

test('rejects a zero cap (must be >= 1)', () => {
  const { errors } = checkConfigShape({ tool_output: { max_lines: 0, max_bytes: 40000 } });
  assert.ok(errors.some((e) => /tool_output\.max_lines is not a positive integer/.test(e)));
});

test('rejects a string watcher.ignore (shape is a list, not a scalar)', () => {
  const { errors } = checkConfigShape({ watcher: { ignore: '**/node_modules/**' } });
  assert.ok(errors.some((e) => /watcher\.ignore is not a non-empty array of strings/.test(e)));
});

test('rejects an empty watcher.ignore', () => {
  const { errors } = checkConfigShape({ watcher: { ignore: [] } });
  assert.ok(errors.some((e) => /watcher\.ignore is not a non-empty array of strings/.test(e)));
});

test('rejects a non-string element in watcher.ignore', () => {
  const { errors } = checkConfigShape({ watcher: { ignore: ['**/ok/**', 7] } });
  assert.ok(errors.some((e) => /watcher\.ignore is not a non-empty array of strings/.test(e)));
});

// ─── Missing required sub-keys ───────────────────────────────────────────────

test('rejects a tool_output missing a required sub-key', () => {
  const { errors } = checkConfigShape({ tool_output: { max_lines: 800 } });
  assert.ok(errors.some((e) => /tool_output\.max_bytes is missing/.test(e)));
});

test('rejects a compaction.keep missing its nested tokens', () => {
  const { errors } = checkConfigShape({ compaction: { keep: {} } });
  assert.ok(errors.some((e) => /compaction\.keep\.tokens is missing/.test(e)));
});

test('rejects a compaction.keep.tokens of the wrong type', () => {
  const { errors } = checkConfigShape({ compaction: { keep: { tokens: '15000' } } });
  assert.ok(errors.some((e) => /compaction\.keep\.tokens is not a positive integer/.test(e)));
});

test('rejects an unknown nested sub-key: compaction.keep.tokenz', () => {
  const { errors } = checkConfigShape({ compaction: { keep: { tokens: 15000, tokenz: 9 } } });
  assert.ok(errors.some((e) => /compaction\.keep\.tokenz is not a declared sub-key/.test(e)));
});

// ─── Object-valued key of the wrong type entirely ────────────────────────────

test('rejects a non-object managed key', () => {
  const { errors } = checkConfigShape({ tool_output: 'big' });
  assert.ok(errors.some((e) => /tool_output is not an object/.test(e)));
});

// ─── Coverage: a managed key must carry a shape spec (the P1 coupling) ───────

test('every managed key has a declared shape', () => {
  const { errors, lines } = checkShapeCoverage(['watcher', 'tool_output', 'compaction']);
  assert.deepEqual(errors, []);
  assert.ok(lines.every((l) => l.includes('✓')));
});

test('a managed key with no shape spec fails closed', () => {
  const { errors, lines } = checkShapeCoverage(['watcher', 'tool_output', 'newly_managed']);
  assert.ok(errors.some((e) => /newly_managed is managed but has no declared value shape/.test(e)));
  assert.ok(lines.some((l) => l.includes('newly_managed') && l.includes('✗')));
});

// ─── Error strings are stable (the validator prints them verbatim) ───────────

test('each failure has a matching ✗ line', () => {
  const { errors, lines } = checkConfigShape({ tool_output: { max_line: 800 } });
  assert.equal(lines.length, errors.length, 'one line per error');
  assert.ok(lines.every((l) => l.includes('✗')));
});
