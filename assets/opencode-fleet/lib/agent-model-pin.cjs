#!/usr/bin/env node
/**
 * agent-model-pin.cjs
 *
 * The agent model-frontmatter contract: a fleet agent pins an established
 * synthetic ALIAS, never a dated model id.
 *
 * Why this exists: Synthetic repoints an alias (`syn:large:text`) to the
 * current large model, so the fleet follows the upgrade with no config edit. A
 * pin to a dated id (`synthetic/hf:moonshotai/Kimi-K3`) freezes the fleet to
 * whatever the model was on the day it was written and silently drifts stale.
 * The golden-n1 pin (3b42eee) introduced exactly this; n=30 reverts it.
 *
 * The check is fail-closed and enumerates the four established aliases rather
 * than pattern-matching a shape: `syn:auto` is a real synthetic id but it is the
 * unrouted reach gap (verify-effective-model.cjs), never a valid fleet pin, and
 * a shape regex would admit it.
 *
 * `isSyntheticAlias(model)` — true only for an alias in SYNTHETIC_ALIASES.
 * `checkAgentModel(name, model)` returns `{ errors, lines }`:
 *   errors — one string when the model is not an established alias
 *   lines  — the human-readable ✗ line for the validator to print
 *
 * Exit codes: this module has no CLI; it is a pure predicate.
 */

'use strict';

// The established alias table. This is the operator's published set; a new
// alias is added here deliberately, not inferred by shape.
const SYNTHETIC_ALIASES = new Set([
  'synthetic/syn:large:text',
  'synthetic/syn:small:text',
  'synthetic/syn:large:vision',
  'synthetic/syn:small:vision',
]);

/** True only when `model` is one of the established synthetic aliases. */
function isSyntheticAlias(model) {
  return typeof model === 'string' && SYNTHETIC_ALIASES.has(model);
}

/**
 * Validate one agent's `model:` value against the alias contract.
 * `model` may be undefined (absent pin) — that is an error here, since the
 * caller only invokes this for agents that must be pinned.
 */
function checkAgentModel(name, model) {
  if (isSyntheticAlias(model)) return { errors: [], lines: [] };
  const shown = model ? `'${model}'` : 'absent';
  const expected = [...SYNTHETIC_ALIASES].join(', ');
  return {
    errors: [`${name} model is not an established alias`],
    lines: [`  ✗  ${name} — model is ${shown}, not an established alias (expected one of: ${expected})`],
  };
}

module.exports = { SYNTHETIC_ALIASES, isSyntheticAlias, checkAgentModel };
