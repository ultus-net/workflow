#!/usr/bin/env node
/**
 * config-shape.cjs
 *
 * Declared value shape for the overlay's managed object-valued keys.
 *
 * validate-config.cjs fails closed on an *unclassified top-level key*, but it
 * checks no value shape. The running host normalizes each key independently and
 * drops unknown sub-properties (`onExcessProperty:"ignore"`), so a renamed or
 * wrong-typed sub-key is silently discarded and the cap it names reverts to the
 * built-in default while every gate stays green. This is the L015/L023 class
 * ("convergence is not effect"; "a claimed gate may not exist") applied to the
 * config values themselves.
 *
 * The check is overlay-only (it never reads the live file) and fail-closed: an
 * unknown sub-key, a wrong type, or a missing required sub-key is an error.
 *
 * `checkConfigShape(parsed)` returns `{ errors, lines }`:
 *   errors — one string per failing key/sub-key (empty on success)
 *   lines  — the human-readable ✓/✗ lines for the validator to print
 *
 * `checkShapeCoverage(keys)` returns the same shape for every managed `key`
 * with no entry in `SHAPES`. The validator passes `CONVERGE_MANAGED`, so the
 * classification list and this spec cannot drift apart silently.
 *
 * Exit codes: this module has no CLI; it is a pure predicate.
 */

'use strict';

// ─── Value-kind predicates ───────────────────────────────────────────────────

const isObj     = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt  = (v) => Number.isInteger(v) && v >= 1;
const isNonNeg  = (v) => Number.isInteger(v) && v >= 0;
const isBool    = (v) => typeof v === 'boolean';
const isStr     = (v) => typeof v === 'string' && v.length > 0;
const isStrList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');

// ─── Shape spec for the managed / shared object-valued keys ──────────────────
//
// `required` sub-keys must be present and match; `optional` sub-keys, if
// present, must match. Any sub-key not listed here is an error (fail closed).
// A sub-key may carry `nested`, an object spec applied recursively.

const INT = { check: isPosInt, kind: 'positive integer' };
const NONNEG = { check: isNonNeg, kind: 'non-negative integer' };
const BOOL = { check: isBool, kind: 'boolean' };
const STR = { check: isStr, kind: 'non-empty string' };
const STRLIST = { check: isStrList, kind: 'non-empty array of strings' };

const SHAPES = {
  // Context caps: the keys whose silent loss is the whole point of the check.
  tool_output: {
    required: { max_lines: INT, max_bytes: INT },
    optional: {},
  },
  watcher: {
    required: { ignore: STRLIST },
    optional: {},
  },
  // SHARED, but `keep.tokens` is a cap: pin the nested shape too.
  compaction: {
    required: {
      keep: { check: isObj, kind: 'object', nested: { required: { tokens: INT }, optional: {} } },
    },
    optional: {
      auto: BOOL,
      buffer: NONNEG,
    },
  },
  worktree: {
    required: { directory: STR },
    optional: {},
  },
};

// ─── Coverage guard ──────────────────────────────────────────────────────────
//
// The top-level classification list and SHAPES are two declarations. A key the
// convergence mechanism may *write* (CONVERGE_MANAGED) must have a shape spec, or
// the exact defect this module exists to catch (a renamed sub-key on a managed
// key shipping green) escapes one level up. `checkShapeCoverage` makes that
// coupling a checked invariant instead of a comment.

/**
 * Return `{ errors, lines }` for every `key` with no entry in `SHAPES`.
 * Pass the keys the classification marks as overlay-owned by value
 * (`CONVERGE_MANAGED`), so a new managed key cannot ship without a shape spec.
 */
function checkShapeCoverage(keys) {
  const errors = [];
  const lines = [];
  for (const key of keys) {
    if (SHAPES[key]) {
      lines.push(`  ✓  config.jsonc — ${key} has a declared value shape`);
    } else {
      errors.push(`${key} is managed but has no declared value shape`);
      lines.push(`  ✗  config.jsonc — ${key} is managed but has no declared value shape (add it to SHAPES in config-shape.cjs)`);
    }
  }
  return { errors, lines };
}

// ─── Recursive checker ───────────────────────────────────────────────────────

/**
 * Validate `value` against `spec`, appending any failures to `errors` and the
 * human-readable line to `lines` under `label`. Returns the error count added.
 */
function checkAgainst(value, spec, label, errors, lines) {
  const before = errors.length;
  if (!isObj(value)) {
    errors.push(`${label} is not an object`);
    lines.push(`  ✗  config.jsonc — ${label} must be an object`);
    return 1;
  }

  const required = spec.required || {};
  const optional = spec.optional || {};

  for (const [sub, subSpec] of Object.entries(required)) {
    if (!Object.prototype.hasOwnProperty.call(value, sub)) {
      errors.push(`${label}.${sub} is missing`);
      lines.push(`  ✗  config.jsonc — ${label}.${sub} is missing (required ${subSpec.kind})`);
    }
  }

  for (const [sub, subValue] of Object.entries(value)) {
    const subSpec = required[sub] || optional[sub];
    if (!subSpec) {
      errors.push(`${label}.${sub} is not a declared sub-key`);
      lines.push(`  ✗  config.jsonc — ${label}.${sub} is not a declared sub-key`);
      continue;
    }
    if (subSpec.nested) {
      checkAgainst(subValue, subSpec.nested, `${label}.${sub}`, errors, lines);
      continue;
    }
    if (!subSpec.check(subValue)) {
      errors.push(`${label}.${sub} is not a ${subSpec.kind}`);
      lines.push(`  ✗  config.jsonc — ${label}.${sub} must be a ${subSpec.kind}`);
    }
  }

  return errors.length - before;
}

/**
 * Check the value shape of every declared key that has a shape spec.
 * `parsed` is the overlay's parsed object. Returns `{ errors, lines }`.
 */
function checkConfigShape(parsed) {
  const errors = [];
  const lines = [];
  if (!isObj(parsed)) {
    return { errors: ['config root is not an object'], lines: ['  ✗  config.jsonc — root is not an object'] };
  }

  for (const [key, spec] of Object.entries(SHAPES)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    const added = checkAgainst(parsed[key], spec, key, errors, lines);
    if (added === 0) {
      lines.push(`  ✓  config.jsonc — ${key} value shape`);
    }
  }

  return { errors, lines };
}

module.exports = { checkConfigShape, checkShapeCoverage, SHAPES };
