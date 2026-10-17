#!/usr/bin/env node
/**
 * test-effective-model.cjs
 *
 * Fixture tests for verify-effective-model.cjs. Builds a throwaway SQLite
 * `session_v2` store and a throwaway agent directory, then asserts the verifier
 * separates known-good post-pin sessions from the pre-pin `syn:auto` reach gap,
 * tolerates OpenRouter failover rows, and degrades gracefully with no store.
 *
 * Run: node --test install/lib/test-effective-model.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const v = require('./verify-effective-model.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vem-'));
}

function writeAgents(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'executor.md'),
    '---\ndescription: cheap\nmodel: synthetic/syn:small:text\n---\nbody\n',
  );
  fs.writeFileSync(
    path.join(dir, 'reviewer.md'),
    // mode: primary so a test can name it as a selectable default and grade it by its pin.
    '---\ndescription: strong\nmode: primary\nmodel: synthetic/syn:large:text\n---\nbody\n',
  );
  // Unpinned agent: must not be graded.
  fs.writeFileSync(path.join(dir, 'loose.md'), '---\ndescription: no pin\n---\nbody\n');
}

function writeDb(dbPath, rows) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, agent TEXT, model TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER)`);
  const insert = db.prepare(
    'INSERT INTO session_v2 (id, agent, model, cost, tokens_input, tokens_output, time_created) VALUES (?,?,?,?,?,?,?)',
  );
  rows.forEach((r, i) =>
    insert.run(
      `s${i}`, r.agent, r.model, r.cost ?? 0, r.tin ?? 0, r.tout ?? 0, r.t ?? 0,
    ),
  );
  db.close();
}

const model = (providerID, id) => JSON.stringify({ providerID, id });

test('parseFrontmatter + intendedModels reads only pinned agents', () => {
  const dir = tmpdir();
  writeAgents(dir);
  const intended = v.intendedModels(dir);
  assert.ok(intended, 'dir has agents');
  assert.deepEqual(intended.executor, { providerID: 'synthetic', id: 'syn:small:text' });
  assert.deepEqual(intended.reviewer, { providerID: 'synthetic', id: 'syn:large:text' });
  assert.equal(intended.loose, undefined, 'unpinned agent is not graded');
});

test('classify separates routed, unrouted, wrong-tier, and off-provider', () => {
  const intended = { providerID: 'synthetic', id: 'syn:large:text' };
  assert.equal(v.classify({ providerID: 'synthetic', id: 'syn:large:text' }, intended), 'ok');
  assert.equal(v.classify({ providerID: 'synthetic', id: 'syn:auto' }, intended), 'unrouted');
  assert.equal(v.classify({ providerID: 'synthetic', id: 'syn:small:text' }, intended), 'wrong-tier');
  assert.equal(v.classify({ providerID: 'openrouter', id: 'openrouter/auto' }, intended), 'off-provider');
  assert.equal(v.classify(null, intended), 'unparseable', 'malformed model is drift, not failover');
});

test('post-pin window is clean; pre-pin window flags the reach gap', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  const PIN = Date.parse('2026-10-02T06:10:00Z');

  writeDb(dbPath, [
    // pre-pin: custom agents left on syn:auto → unrouted (the reach gap)
    { agent: 'reviewer', model: model('synthetic', 'syn:auto'), t: PIN - 86_400_000 },
    { agent: 'executor', model: model('synthetic', 'syn:auto'), t: PIN - 86_400_000 },
    // post-pin: routed correctly
    { agent: 'reviewer', model: model('synthetic', 'syn:large:text'), t: PIN + 1000 },
    { agent: 'executor', model: model('synthetic', 'syn:small:text'), t: PIN + 1000 },
    // legitimate OpenRouter failover must NOT count as drift
    { agent: 'reviewer', model: model('openrouter', 'openrouter/auto'), t: PIN + 2000 },
    // an unpinned agent row is ignored
    { agent: 'loose', model: model('synthetic', 'syn:auto'), t: PIN + 3000 },
  ]);

  const post = v.verify({ agentsDir, dbPath, since: PIN });
  assert.equal(post.drift, 0, 'post-pin window has no drift');
  assert.equal(post.agents.reviewer.ok, 1);
  assert.equal(post.agents.reviewer['off-provider'], 1, 'failover tolerated');
  assert.equal(post.totals.graded, 3);

  const all = v.verify({ agentsDir, dbPath });
  assert.ok(all.drift >= 2, 'pre-pin syn:auto rows count as drift');
  assert.equal(all.agents.reviewer.unrouted, 1);
  assert.equal(all.agents.executor.unrouted, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrong-tier (small where large intended) is drift', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:small:text'), t: 1 },
  ]);
  const r = v.verify({ agentsDir, dbPath });
  assert.equal(r.agents.reviewer['wrong-tier'], 1);
  assert.equal(r.drift, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a malformed model column is drift, not silently green', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: 'not-json-at-all', t: 1 },
    { agent: 'executor', model: '{}', t: 1 },
  ]);
  const r = v.verify({ agentsDir, dbPath });
  assert.equal(r.agents.reviewer.unparseable, 1);
  assert.equal(r.agents.executor.unparseable, 1, 'a JSON object with no providerID is unparseable');
  assert.equal(r.drift, 2, 'format drift must fail loud, not pass as off-provider');
  assert.equal(v.main(['--db', dbPath, '--agents', agentsDir, '--no-default']), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a flag missing its value is a usage error (exit 2), not a crash', () => {
  assert.equal(v.main(['--db']), 2);
  assert.equal(v.main(['--since']), 2);
  assert.equal(v.main(['--agents']), 2);
});

test('a bad --agents dir fails loud instead of silently grading nothing', () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:auto'), t: 1 },
  ]);
  // Typo'd / nonexistent agents dir.
  const r = v.verify({ agentsDir: path.join(dir, 'nope-agents'), dbPath });
  assert.match(r.error, /agents dir not readable/);
  assert.equal(r.skipped, null);
  assert.equal(v.main(['--db', dbPath, '--agents', path.join(dir, 'nope-agents'), '--no-default']), 1);

  // Existing dir with no pinned agents.
  const bare = path.join(dir, 'bare-agents');
  fs.mkdirSync(bare, { recursive: true });
  const empty = v.verify({ agentsDir: bare, dbPath });
  assert.match(empty.error, /no pinned agents/);
  assert.equal(v.main(['--db', dbPath, '--agents', bare, '--no-default']), 1);

  // Omitted agentsDir gives a clear message, not "not readable: undefined".
  const omitted = v.verify({ dbPath });
  assert.match(omitted.error, /no agents dir given/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing store and missing table degrade gracefully (skip, no drift)', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);

  const missing = v.verify({ agentsDir, dbPath: path.join(dir, 'nope.db') });
  assert.match(missing.skipped, /no store/);
  assert.equal(missing.drift, 0);

  const emptyDb = path.join(dir, 'empty.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(emptyDb); db.exec('CREATE TABLE unrelated (x)'); db.close();
  const noTable = v.verify({ agentsDir, dbPath: emptyDb });
  assert.match(noTable.skipped, /no session_v2/);
  assert.equal(noTable.drift, 0);
  assert.equal(noTable.error, null);
  assert.equal(v.main(['--db', emptyDb, '--agents', agentsDir, '--no-default']), 0, 'absent table is inert');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a present-but-wrong-schema session_v2 fails loud, not green', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'drifted.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  // Same table name, missing the columns the verifier reads.
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, agent TEXT)');
  db.close();

  const r = v.verify({ agentsDir, dbPath });
  assert.equal(r.skipped, null, 'a present table is not "absence"');
  assert.match(r.error, /missing column/);
  assert.equal(r.drift, 0);
  assert.equal(v.main(['--db', dbPath, '--agents', agentsDir, '--no-default']), 1, 'schema drift must exit non-zero');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI exits 1 on drift, 0 on a clean window', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:auto'), t: 1 },
  ]);
  const rcDrift = v.main(['--db', dbPath, '--agents', agentsDir, '--no-default']);
  assert.equal(rcDrift, 1);

  const db2 = path.join(dir, 'clean.db');
  writeDb(db2, [{ agent: 'reviewer', model: model('synthetic', 'syn:large:text'), t: 1 }]);
  const rcClean = v.main(['--db', db2, '--agents', agentsDir, '--no-default']);
  assert.equal(rcClean, 0);

  assert.equal(v.main(['--bogus']), 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Default session agent check (adversarial P2-4) ──────────────────────────

function writeConfig(file, contents) {
  fs.writeFileSync(file, contents);
}

test('readDefaultAgent resolves the key, falls back to build when unset, errors on bad input', () => {
  const dir = tmpdir();
  const cfg = path.join(dir, 'config.jsonc');
  writeConfig(cfg, '{\n  // a comment the JSONC normalizer strips\n  "default_agent": "plan"\n}\n');
  assert.deepEqual(v.readDefaultAgent(cfg), { id: 'plan', present: true });

  const unset = path.join(dir, 'unset.jsonc');
  writeConfig(unset, '{ "tool_output": { "max_lines": 800 } }');
  assert.deepEqual(v.readDefaultAgent(unset), { id: 'build', present: false }, 'unset key → host default build');

  const broken = path.join(dir, 'broken.jsonc');
  writeConfig(broken, '{ "default_agent": ');
  assert.match(v.readDefaultAgent(broken).error, /does not parse as JSONC/);

  const nonString = path.join(dir, 'nonstring.jsonc');
  writeConfig(nonString, '{ "default_agent": 7 }');
  assert.match(v.readDefaultAgent(nonString).error, /not a non-empty string/);

  assert.match(v.readDefaultAgent(path.join(dir, 'nope.jsonc')).error, /not readable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isSelectable: selectability first, matching the host admission rule', () => {
  // fleet maps a fleet agent id to its selection fields ({ mode, hidden }).
  const fleet = {
    reviewer: { mode: 'subagent', hidden: false }, // a pinned SUBAGENT: host ignores it as default
    planner: { mode: 'primary', hidden: false },
    allmodes: { mode: 'all', hidden: false },
    loose: { mode: undefined, hidden: false },     // no declared mode → host default primary
    weird: { mode: 'chat', hidden: false },         // a mode outside today's enum: host excludes only subagent
    shadowed: { mode: 'primary', hidden: true },   // hidden primary: not selectable
  };
  assert.equal(v.isSelectable('reviewer', fleet), false,
    'a subagent is not selectable, so its pin must NOT be graded as the default');
  assert.equal(v.isSelectable('build', fleet), true);
  assert.equal(v.isSelectable('plan', fleet), true);
  assert.equal(v.isSelectable('planner', fleet), true, 'a pin-less primary fleet agent');
  assert.equal(v.isSelectable('allmodes', fleet), true, 'mode: all is selectable');
  assert.equal(v.isSelectable('loose', fleet), true, 'no declared mode → primary → selectable');
  assert.equal(v.isSelectable('weird', fleet), true, 'the host excludes only subagent, so an unrecognized mode stays selectable');
  assert.equal(v.isSelectable('shadowed', fleet), false, 'hidden is not selectable');
  assert.equal(v.isSelectable('general', fleet), false, 'a built-in subagent is not selectable');
  assert.equal(v.isSelectable('nope', fleet), false);
});

test('a hidden fleet agent is not selectable (frontmatter string coerced)', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  // `hidden: true` in frontmatter is a STRING; fleetSelectability must coerce it
  // to a boolean, else a hidden agent would look selectable.
  fs.writeFileSync(path.join(agentsDir, 'hidden-pinned.md'),
    '---\ndescription: hidden\nmode: primary\nhidden: true\nmodel: synthetic/syn:large:text\n---\nbody\n');
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [{ agent: 'hidden-pinned', model: model('synthetic', 'syn:large:text'), t: 1 }]);
  const cfg = path.join(dir, 'config.jsonc');
  writeConfig(cfg, '{ "default_agent": "hidden-pinned" }');
  const r = v.verify({ agentsDir, dbPath, configPath: cfg });
  assert.match(r.error, /names no selectable agent/);
  assert.equal(r.defaultAgent.selectable, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a selectable fleet pin is graded by its pin; a subagent pin fails loud', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  // A primary-mode pinned agent: selectable, so the default resolves to its pin.
  fs.writeFileSync(path.join(agentsDir, 'primary-pinned.md'),
    '---\ndescription: selectable\nmode: primary\nmodel: synthetic/syn:large:text\n---\nbody\n');
  // A subagent pinned agent: NOT selectable — the host would fall back to build.
  fs.writeFileSync(path.join(agentsDir, 'sub-pinned.md'),
    '---\ndescription: sub\nmode: subagent\nmodel: synthetic/syn:small:text\n---\nbody\n');

  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'primary-pinned', model: model('synthetic', 'syn:small:text'), t: 1 },
    { agent: 'sub-pinned', model: model('synthetic', 'syn:small:text'), t: 2 },
  ]);

  const cfgPin = path.join(dir, 'pin.jsonc');
  writeConfig(cfgPin, '{ "default_agent": "primary-pinned" }');
  const rPin = v.verify({ agentsDir, dbPath, configPath: cfgPin });
  assert.equal(rPin.error, null);
  assert.equal(rPin.defaultAgent.selectable, true);
  assert.equal(rPin.agents['primary-pinned'].default, true);
  assert.equal(rPin.agents['primary-pinned']['wrong-tier'], 1, 'graded by the pin (small vs large)');

  const cfgSub = path.join(dir, 'sub.jsonc');
  writeConfig(cfgSub, '{ "default_agent": "sub-pinned" }');
  const rSub = v.verify({ agentsDir, dbPath, configPath: cfgSub });
  assert.match(rSub.error, /names no selectable agent/);
  assert.equal(rSub.defaultAgent.selectable, false, 'a subagent is not a usable default');
  assert.equal(rSub.agents['sub-pinned'].default, undefined, 'the subagent is NOT marked as the default');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a default naming a fleet pin is graded by its pin, not double-counted', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  const cfg = path.join(dir, 'config.jsonc');
  writeConfig(cfg, '{ "default_agent": "reviewer" }');
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:small:text'), t: 1 }, // wrong tier vs large pin
  ]);

  const r = v.verify({ agentsDir, dbPath, configPath: cfg });
  assert.equal(r.error, null);
  assert.equal(r.defaultAgent.selectable, true);
  assert.equal(r.agents.reviewer.default, true);
  assert.equal(r.agents.reviewer['wrong-tier'], 1, 'graded by the pin, so wrong-tier applies');
  assert.equal(r.agents.reviewer.unrouted, 0);
  assert.equal(r.agents.reviewer.ok, 0);
  assert.equal(r.totals.graded, 1, 'one row, one session — no double count');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a default naming no selectable agent fails loud (a rename cannot pass green)', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  const cfg = path.join(dir, 'config.jsonc');
  writeConfig(cfg, '{ "default_agent": "typo-agent" }');
  writeDb(dbPath, [{ agent: 'reviewer', model: model('synthetic', 'syn:large:text'), t: 1 }]);

  const r = v.verify({ agentsDir, dbPath, configPath: cfg });
  assert.match(r.error, /names no selectable agent/);
  assert.equal(r.defaultAgent.selectable, false);
  assert.equal(
    v.main(['--db', dbPath, '--agents', agentsDir, '--config', cfg]),
    1,
    'an unresolvable default is an error, not a silent skip',
  );

  // A config that cannot be read is an error too.
  const bad = path.join(dir, 'missing.jsonc');
  const r2 = v.verify({ agentsDir, dbPath, configPath: bad });
  assert.match(r2.error, /config not readable/);
  assert.equal(v.main(['--db', dbPath, '--agents', agentsDir, '--config', bad]), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a config whose root is not an object fails loud, not "unset → build"', () => {
  const dir = tmpdir();
  const nullCfg = path.join(dir, 'null.jsonc');
  writeConfig(nullCfg, 'null');
  assert.match(v.readDefaultAgent(nullCfg).error, /root is not an object/);
  const arrCfg = path.join(dir, 'arr.jsonc');
  writeConfig(arrCfg, '[]');
  assert.match(v.readDefaultAgent(arrCfg).error, /root is not an object/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the CLI defaults --config to the overlay config, and --no-default disables it', () => {
  // The enabling mechanism: parseArgs must point configPath at the overlay, and
  // --no-default must null it. A future edit dropping the default line would
  // leave the live default-agent check silently inert — this pins it.
  const on = v.parseArgs([]);
  assert.equal(on.error, undefined);
  assert.ok(on.configPath, 'configPath defaults to a path');
  assert.ok(/install[\\/]opencode[\\/]config\.jsonc$/.test(on.configPath),
    `configPath must reach the overlay config, got ${on.configPath}`);
  assert.equal(v.parseArgs(['--no-default']).configPath, null);
});

test('the CLI prints the default agent row with a (default) marker', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'clean.db');
  const cfg = path.join(dir, 'config.jsonc');
  writeConfig(cfg, '{ "default_agent": "reviewer" }'); // a selectable fleet pin
  writeDb(dbPath, [
    { agent: 'reviewer', model: model('synthetic', 'syn:large:text'), t: 1 },
    { agent: 'executor', model: model('synthetic', 'syn:small:text'), t: 1 },
  ]);

  // Capture stdout around the call; exit is 0 (no drift).
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  const rc = v.main(['--db', dbPath, '--agents', agentsDir, '--config', cfg]);
  console.log = orig;
  assert.equal(rc, 0);
  assert.ok(out.some((l) => l.includes('reviewer (default)')), 'the default row is labeled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('omitting the config preserves the pre-change contract exactly', () => {
  const dir = tmpdir();
  const agentsDir = path.join(dir, 'agents');
  writeAgents(agentsDir);
  const dbPath = path.join(dir, 'opencode.db');
  writeDb(dbPath, [
    { agent: 'build', model: model('synthetic', 'syn:auto'), t: 1 }, // would drift IF build were pinned
    { agent: 'reviewer', model: model('synthetic', 'syn:large:text'), t: 1 },
  ]);

  const r = v.verify({ agentsDir, dbPath }); // no configPath
  assert.equal(r.defaultAgent, null, 'no default resolution without a config');
  assert.equal(r.agents.build, undefined, 'build stays ungraded without a config');
  assert.equal(r.drift, 0);
  assert.equal(r.totals.graded, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
