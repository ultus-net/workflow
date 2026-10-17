#!/usr/bin/env node
/**
 * test-validate-commands.cjs
 *
 * Fixture tests for validate-commands.cjs's command-frontmatter classification
 * (RSI n=39). Pure: `validateCommand` takes text, so these fixtures never touch
 * the real commands dir.
 *
 * Pins the fail-closed contract. The host decodes a command's frontmatter as
 * Config.Command {template(req), description?, agent?, model?, subagent?,
 * subtask?} with `Schema.decodeUnknownOption` and `if (!info) return` — a
 * wrong TYPE drops the whole command silently — while the schema decodes with
 * `onExcessProperty: "ignore"`, so an unrecognized KEY ships inert. A dangling
 * `agent:` resolves to `info: undefined` (AgentV2.resolve, no throw) and
 * silently falls back to the default agent. Each of those is a silent no-op the
 * gate must fail, not ship.
 *
 * Host contract pinned at opencode v2.0.10:
 *   - binary: `class Mg extends yt("Config.Command")({template,description,
 *     agent,model,subagent,subtask})`, `onExcessProperty:"ignore"`, and the
 *     deprecated-alias annotation on subtask
 *   - source (v1.18.31, same shape): packages/core/src/config/plugin/command.ts
 *     (decode + `if (!info) return`), packages/core/src/config/command.ts
 *   - built-in agent ids: packages/core/src/agent.ts (defaultID "build"),
 *     packages/core/src/plugin/agent.ts (plan/general/explore seeds)
 *
 * Run: node --test install/lib/test-validate-commands.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateCommand, KNOWN_KEYS, BUILTIN_AGENTS } = require('./validate-commands.cjs');

const AGENTS = new Set(['decompose', 'executor', 'executor-strong', 'retrospective', 'reviewer', 'screener', ...BUILTIN_AGENTS]);

/** A minimal valid command with the given frontmatter lines and body. */
function command(lines, body = 'Do the thing.') {
  return ['---', 'description: x', ...lines, '---', '', body, ''].join('\n');
}

/** Errors for a command whose frontmatter is `lines`. */
function errsFor(lines) {
  return validateCommand('x.md', command(lines), AGENTS).errors;
}

test('a valid command passes', () => {
  assert.deepEqual(validateCommand('x.md', command([]), AGENTS).errors, []);
});

test('missing frontmatter fails', () => {
  const e = validateCommand('x.md', 'no frontmatter here\n', AGENTS).errors;
  assert.ok(e.some((m) => /Missing or malformed YAML frontmatter/.test(m)), JSON.stringify(e));
});

test('missing description fails', () => {
  const text = ['---', 'agent: reviewer', '---', '', 'body', ''].join('\n');
  const e = validateCommand('x.md', text, AGENTS).errors;
  assert.ok(e.some((m) => /missing required non-empty field: 'description'/.test(m)), JSON.stringify(e));
});

test('a dangling agent reference fails (silent fallback to the default)', () => {
  const e = errsFor(['agent: rewier']);
  assert.ok(e.some((m) => /names no known agent/.test(m) && /rewier/.test(m)), JSON.stringify(e));
});

test('every real fleet agent and every host built-in is accepted', () => {
  for (const a of AGENTS) {
    assert.deepEqual(errsFor([`agent: ${a}`]), [], `agent '${a}' should be accepted`);
  }
});

test('a non-boolean subagent fails (the command is silently dropped)', () => {
  for (const v of ['yes', '1', '"true"']) {
    const e = errsFor([`subagent: ${v}`]);
    assert.ok(e.some((m) => /'subagent: .*' is not a boolean/.test(m)), `subagent: ${v} -> ${JSON.stringify(e)}`);
  }
  assert.deepEqual(errsFor(['subagent: true']), []);
  assert.deepEqual(errsFor(['subagent: false']), []);
});

test('both subagent and subtask fails', () => {
  const e = errsFor(['subagent: true', 'subtask: true']);
  assert.ok(e.some((m) => /both 'subagent' and 'subtask' are set/.test(m)), JSON.stringify(e));
});

test('subtask alone is accepted but warns (deprecated alias)', () => {
  const { errors, warnings } = validateCommand('x.md', command(['subtask: true']), AGENTS);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((m) => /deprecated/.test(m)), JSON.stringify(warnings));
});

test('an unknown frontmatter key fails (host decodes with onExcessProperty: ignore)', () => {
  const e = errsFor(['steps: 5']);
  assert.ok(e.some((m) => /unknown frontmatter key 'steps'/.test(m)), JSON.stringify(e));
});

test('a frontmatter template is inert, not unknown (warned, not an error)', () => {
  const { errors, warnings } = validateCommand('x.md', command(['template: nope']), AGENTS);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((m) => /'template' is overwritten/.test(m)), JSON.stringify(warnings));
});

test('a malformed model fails; host-valid multi-slash models pass', () => {
  assert.ok(errsFor(['model: notamodel']).some((m) => /is not 'provider\/model'/.test(m)));
  // The host guard is /^[^/#]+\/[^#]+$/, so the model segment may contain
  // slashes (a nested org path) but not a hash.
  assert.deepEqual(errsFor(['model: synthetic/syn:large:text']), []);
  assert.deepEqual(errsFor(['model: synthetic/hf:moonshotai/Kimi-K3']), []);
  assert.ok(errsFor(['model: prov/mod#frag']).some((m) => /is not 'provider\/model'/.test(m)));
});

test('a non-string description fails (Schema.String decode drops the command)', () => {
  for (const tok of ['true', 'null', '~', '5', '1.5']) {
    const text = ['---', `description: ${tok}`, '---', '', 'body', ''].join('\n');
    const e = validateCommand('x.md', text, AGENTS).errors;
    assert.ok(e.some((m) => /'description: .*' is a YAML (boolean|null|number)/.test(m)), `${tok} -> ${JSON.stringify(e)}`);
  }
});

test('a quoted scalar is a YAML string and is not a type error', () => {
  // A quoted "5" is a string, so it is not a Schema.String type failure; it
  // simply names no known agent.
  const e = errsFor(['agent: "5"']);
  assert.deepEqual(e.length, 1);
  assert.ok(/names no known agent/.test(e[0]), JSON.stringify(e));
  // A quoted numeric description is a valid string.
  assert.deepEqual(validateCommand('x.md', ['---', 'description: "5"', '---', '', 'b', ''].join('\n'), AGENTS).errors, []);
});


test('an empty agent fails (it resolves to no agent, like a typo)', () => {
  const e = errsFor(['agent:']);
  assert.ok(e.some((m) => /names no known agent/.test(m)), JSON.stringify(e));
});

test('a duplicated frontmatter key fails (the host silently last-wins)', () => {
  const text = ['---', 'description: x', 'agent: reviewer', 'agent: nope', '---', '', 'body', ''].join('\n');
  const e = validateCommand('x.md', text, AGENTS).errors;
  assert.ok(e.some((m) => /'agent' is declared more than once/.test(m)), JSON.stringify(e));
});

test('a host-valid multi-slash model is not mistaken for an unknown key', () => {
  assert.deepEqual(errsFor(['model: synthetic/hf:moonshotai/Kimi-K3']), []);
});

test('variant is rejected as an unknown key (not a decoded v2 command key)', () => {
  const e = errsFor(['model: synthetic/syn:large:text', 'variant: high']);
  assert.ok(e.some((m) => /unknown frontmatter key 'variant'/.test(m)), JSON.stringify(e));
});

test('a non-string model fails', () => {
  assert.ok(errsFor(['model: 5']).some((m) => /'model: 5' is a YAML number/.test(m)));
});

test('the known-key set is exactly the host Config.Command keys (minus template)', () => {
  assert.deepEqual([...KNOWN_KEYS].sort(), ['agent', 'description', 'model', 'subagent', 'subtask']);
});

test('the whole shipped command fleet passes with no errors', () => {
  const commandsDir = path.resolve(__dirname, '..', 'opencode', 'commands');
  const agentsDir = path.resolve(__dirname, '..', 'opencode', 'agents');
  // Enumerate the fleet the way main() does, so the fixture exercises the real
  // discovery path (not the hardcoded AGENTS set).
  const known = new Set(BUILTIN_AGENTS);
  for (const f of fs.readdirSync(agentsDir)) if (f.endsWith('.md')) known.add(f.replace(/\.md$/, ''));
  for (const f of fs.readdirSync(commandsDir).filter((n) => n.endsWith('.md')).sort()) {
    const { errors } = validateCommand(f, fs.readFileSync(path.join(commandsDir, f), 'utf8'), known);
    assert.deepEqual(errors, [], `${f} should be clean, got: ${JSON.stringify(errors)}`);
  }
});