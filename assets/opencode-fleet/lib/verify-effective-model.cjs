#!/usr/bin/env node
/**
 * verify-effective-model.cjs
 *
 * The loop's missing ruler: reports each fleet agent's **effective** model from
 * a real session store, not the declared config. `/api/agent` reports what the
 * config *says* (which is why the n=3/n=5 reach gap could not be scored); this
 * reads `session_v2` in the OpenCode SQLite store and compares each session's
 * actual `model` against the tier the agent is pinned to in the overlay.
 *
 * Why this exists: a tier pin is only a win if the *runtime* used it. This tool
 * is the held-out check for that — it must show zero drift on known-good
 * post-pin sessions and flag the pre-pin `syn:auto` reach gap.
 *
 * Intended tier is the single source of truth: the pinned `model:` line in the
 * overlay agent frontmatter (`install/opencode/agents/*.md`). Agents with an
 * explicit pin are graded against it. Unpinned agents (built-ins, strangers)
 * are not graded. The one exception is the DEFAULT session agent, which is
 * checked for RESOLVABILITY (adversarial P2-4), below.
 *
 * The default agent: `default_agent` names the agent every session starts as. A
 * rename to a name the host will not use is a silent no-op (the host falls back
 * to `build`, `packages/core/src/agent.ts:92-97`), so this ruler reads the key
 * (via `stripJsonc`) and fails loud when it resolves to no selectable agent. A
 * selectable default that carries a fleet pin is graded by that pin. Unset
 * resolves to the host default `build`. Resolution is fleet frontmatter + the
 * selectable built-ins (`SELECTABLE_BUILTINS`), not an inline config `agent` map.
 *
 * Classification for a graded agent: ok (exact intended alias), unrouted
 * (syn:auto — the pin did not take effect), wrong-tier (another synthetic
 * alias), off-provider (non-synthetic; failover is legitimate), unparseable
 * (the `model` column is not a JSON object — DRIFT, not failover, and must fail
 * loud rather than turn the ruler green forever).
 *
 * Exit codes: 0 = no drift, or a graceful SKIP (no store / no `session_v2`
 * table: inert, never a spurious failure). 1 = drift (unrouted/wrong-tier/
 * unparseable), a present-but-unreadable store (bad query, missing columns,
 * malformed rows), or an unusable intent source (bad/empty `--agents` dir, no
 * pinned agents, unreadable `--config`, or a `default_agent` that resolves to
 * no selectable agent). Absence of data is a skip; presence of unreadable data
 * is a failure. A typo in an intent source must not grade nothing and exit 0.
 * 2 = usage error.
 *
 * Usage:
 *   node install/lib/verify-effective-model.cjs [--db PATH] [--since ISO]
 *        [--agents DIR] [--config PATH] [--no-default] [--json]
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// One parser, one answer: the same JSONC normalizer the config validator uses.
const { stripJsonc } = require('./validate-config.cjs');

const SYNTHETIC = 'synthetic';
const AUTO_ID   = 'syn:auto';

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Parse YAML-style frontmatter from the top of a markdown file. */
function parseFrontmatter(content) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Read the intended model for each pinned agent from a directory of markdown
 * files. Returns a map `agentId -> { providerID, id }` for files whose
 * frontmatter carries a `model:` in `provider/id` form. Agents without a pin
 * are omitted (not graded).
 */
function intendedModels(agentsDir) {
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const fm = parseFrontmatter(fs.readFileSync(path.join(agentsDir, name), 'utf8'));
    if (!fm || !fm.model) continue;
    const slash = fm.model.indexOf('/');
    if (slash === -1) continue;
    out[name.replace(/\.md$/, '')] = {
      providerID: fm.model.slice(0, slash),
      id:         fm.model.slice(slash + 1),
    };
  }
  return out;
}

/**
 * Read each fleet agent's selection fields (`id -> { mode, hidden }`), needed to
 * resolve `default_agent`. The host selects a default only among non-subagent,
 * non-hidden agents (`packages/core/src/agent.ts:92-97`). A file with no (or
 * unparseable) frontmatter yields `{ mode: undefined, hidden: false }`: the host
 * still loads it and its mode defaults to `primary` (`Info.default`,
 * `packages/schema/src/agent.ts:44`), so it is selectable. The id is always
 * present as a key, distinguishing a fleet agent from a name that is not one.
 */
function fleetSelectability(agentsDir) {
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(agentsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const fm = parseFrontmatter(fs.readFileSync(path.join(agentsDir, name), 'utf8'));
    out[name.replace(/\.md$/, '')] = {
      mode: fm ? fm.mode : undefined,
      hidden: fm ? fm.hidden === 'true' : false,
    };
  }
  return out;
}

/** Classify one effective model against its intended target. */
function classify(effective, intended) {
  if (!intended) return 'no-intent';
  if (effective === null) return 'unparseable';
  if (effective.providerID !== SYNTHETIC) return 'off-provider';
  if (effective.id === intended.id) return 'ok';
  if (effective.id === AUTO_ID) return 'unrouted';
  return 'wrong-tier';
}

// Host built-in agent ids the default selector can pick: `build`/`plan` (from
// the v2 source `packages/core/src/agent.ts:18,92-101`, `plugin/plan.ts:12`).
// The other registry entries are subagents or hidden, so naming them falls back
// to `build`. This set is the source pin for resolution below.
const SELECTABLE_BUILTINS = new Set(['build', 'plan']);

/**
 * Read `default_agent` from an overlay config. Returns `{ id, present }` where
 * `present` distinguishes an unset key from a set one; `{ error }` on an
 * unreadable or unparseable config. Reuses the canonical JSONC normalizer so the
 * ruler and `validate-config.cjs` cannot disagree about what the config says.
 */
function readDefaultAgent(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { error: `config not readable: ${configPath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (err) {
    return { error: `config does not parse as JSONC: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `config root is not an object: ${JSON.stringify(parsed)}` };
  }
  const raw = parsed.default_agent;
  if (raw === undefined) return { id: 'build', present: false }; // host default
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: `default_agent is not a non-empty string: ${JSON.stringify(raw)}` };
  }
  return { id: raw, present: true };
}

/**
 * Would the host accept `id` as a session default? The host's rule is a
 * blacklist (`packages/core/src/agent.ts:92-97`: `mode !== "subagent" &&
 * !hidden`), so this mirrors it exactly rather than whitelisting the modes that
 * exist today: any non-`subagent`, non-hidden mode is selectable, including a
 * mode the host adds later. A fleet agent with no declared mode defaults to
 * `primary` (`packages/schema/src/agent.ts:44`) and is selectable. A fleet agent
 * is keyed in `fleet`; any other id must be one of `SELECTABLE_BUILTINS`. An
 * agent declared inline in the config's `agent` map is not seen. Pure.
 */
function isSelectable(id, fleet) {
  const spec = Object.prototype.hasOwnProperty.call(fleet, id) ? fleet[id] : null;
  if (!spec) return SELECTABLE_BUILTINS.has(id);
  return spec.mode !== 'subagent' && spec.hidden !== true;
}

// ─── Store access ────────────────────────────────────────────────────────────

/**
 * Read effective (agent, model, cost, tokens) rows from the session store.
 * Returns `{ rows, skipped, error }`:
 *   - `skipped` explains a benign no-measurement case (no store, no
 *     `node:sqlite`, no `session_v2` table). The caller exits 0.
 *   - `error` explains a *present but unreadable* store (a table that exists
 *     without the required columns, or a query that throws). The caller exits
 *     non-zero: this is format drift, and must fail loud rather than masquerade
 *     as "no data" (the round-1 fail-open one layer down).
 */
function readSessions(dbPath, since) {
  if (!fs.existsSync(dbPath)) return { rows: [], skipped: `no store at ${dbPath}`, error: null };
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return { rows: [], skipped: 'node:sqlite unavailable in this runtime', error: null };
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { rows: [], skipped: null, error: `cannot open store: ${err.message}` };
  }
  try {
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'")
      .get();
    if (!has) return { rows: [], skipped: 'no session_v2 table', error: null };

    // The table exists: require the columns we read. A renamed/missing column is
    // schema drift, not absence.
    const cols = new Set(
      db.prepare('PRAGMA table_info(session_v2)').all().map((c) => c.name),
    );
    const required = ['agent', 'model', 'cost', 'tokens_input', 'tokens_output', 'time_created'];
    const missing  = required.filter((c) => !cols.has(c));
    if (missing.length > 0) {
      return { rows: [], skipped: null, error: `session_v2 missing column(s): ${missing.join(', ')}` };
    }

    const where  = ['agent IS NOT NULL', 'model IS NOT NULL'];
    const params = [];
    if (since != null) {
      where.push('time_created > ?');
      params.push(since);
    }
    const rows = db
      .prepare(
        `SELECT agent, model, cost, tokens_input, tokens_output, time_created
           FROM session_v2 WHERE ${where.join(' AND ')}`,
      )
      .all(...params);
    return { rows, skipped: null, error: null };
  } catch (err) {
    return { rows: [], skipped: null, error: `query failed: ${err.message}` };
  } finally {
    db.close();
  }
}

/**
 * Parse the JSON `model` column. Returns null when the value is not a JSON
 * object with a string `providerID` and `id` — i.e. anything we cannot classify
 * as a real model. Null is surfaced as `unparseable` (drift), never silently
 * treated as failover.
 */
function parseModel(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.providerID !== 'string' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Verify ──────────────────────────────────────────────────────────────────

/**
 * Compare effective session models to intended pins. `agents` is keyed by agent
 * id and each entry lists per-classification counts, models, cost and tokens.
 * `error` is non-null when the store is present-but-unreadable or the intent
 * source is unusable (a `readSessions` error takes precedence).
 *
 * With `options.configPath`, the config's `default_agent` is checked for
 * resolvability (adversarial P2-4): a name that resolves to no selectable agent
 * is an error (the host would silently fall back to `build`). A selectable
 * default that carries a fleet pin is already graded by that pin and is marked
 * `default`. Without `configPath` (the fixture suite, embedded use) the
 * pre-change behavior holds exactly.
 */
function verify(options = {}) {
  const agentsDir = options.agentsDir;
  const intended  = intendedModels(agentsDir);
  const { rows, skipped, error } = readSessions(options.dbPath, options.since);

  // A missing/unreadable agents dir, or one with no pinned agent, would grade
  // nothing and exit 0 — a silent fail-open for an operator typo. Treat it as an
  // error so the ruler never reports "clean" when it had no intent to check.
  // One try/catch span: statSync also covers a missing path and a race/EACCES
  // that existsSync+statSync could let throw, emitting our message not a stack.
  let dirError = null;
  let isDir = false;
  try { isDir = fs.statSync(agentsDir).isDirectory(); } catch { isDir = false; }
  if (agentsDir == null) {
    dirError = 'no agents dir given';
  } else if (!isDir) {
    dirError = `agents dir not readable: ${agentsDir}`;
  } else if (Object.keys(intended).length === 0) {
    dirError = `no pinned agents found in ${agentsDir}`;
  }

  // Null-prototype map: a store row whose `agent` is `"constructor"` or
  // `"__proto__"` must not resolve to a prototype member and be graded by
  // accident (or write counts onto Object.prototype).
  const agents = Object.create(null);
  for (const id of Object.keys(intended)) {
    agents[id] = { intended: intended[id], ok: 0, unrouted: 0, 'wrong-tier': 0, 'off-provider': 0, unparseable: 0, models: {}, cost: 0, tokens: 0 };
  }

  // Check the default agent (P2-4): a name that resolves to nothing selectable
  // is an error, not a silent skip — the host would fall back to `build`.
  let defaultAgent = null;
  if (options.configPath != null) {
    const read = readDefaultAgent(options.configPath);
    if (read.error) {
      defaultAgent = { error: read.error };
    } else {
      // Read the fleet's selection fields only when the default needs resolving
      // (skips the second directory read on the pre-existing pinned-only path).
      const selectable = isSelectable(read.id, fleetSelectability(agentsDir));
      defaultAgent = { id: read.id, present: read.present, selectable, error: null };
      if (!selectable) {
        defaultAgent.error = `default_agent "${read.id}" names no selectable agent (the host would fall back to build)`;
      } else if (agents[read.id]) {
        agents[read.id].default = true; // already graded by its pin
      }
    }
  }

  for (const row of rows) {
    const spec = agents[row.agent];
    if (!spec) continue; // not a graded agent
    const effective = parseModel(row.model);
    const status    = classify(effective, spec.intended);
    spec[status] = (spec[status] || 0) + 1;
    const label = effective ? `${effective.providerID}/${effective.id}` : 'unparseable';
    spec.models[label] = (spec.models[label] || 0) + 1;
    spec.cost   += Number(row.cost) || 0;
    spec.tokens += (Number(row.tokens_input) || 0) + (Number(row.tokens_output) || 0);
  }

  let drift = 0;
  for (const spec of Object.values(agents)) {
    drift += spec.unrouted + spec['wrong-tier'] + spec.unparseable;
  }

  const graded = Object.values(agents).reduce(
    (n, s) => n + s.ok + s.unrouted + s['wrong-tier'] + s['off-provider'] + s.unparseable,
    0,
  );
  const defaultError = defaultAgent && defaultAgent.error ? defaultAgent.error : null;
  return {
    agents,
    drift,
    skipped,
    error: error ?? dirError ?? defaultError,
    defaultAgent,
    totals: { graded, intendedAgents: Object.keys(intended).length },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    dbPath:   path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    agentsDir: path.resolve(__dirname, '..', 'opencode', 'agents'),
    configPath: path.resolve(__dirname, '..', 'opencode', 'config.jsonc'),
    since:    null,
    json:     false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db')          { const v = argv[++i]; if (v == null) return { error: '--db requires a path' }; opts.dbPath = v; }
    else if (a === '--agents') { const v = argv[++i]; if (v == null) return { error: '--agents requires a directory' }; opts.agentsDir = path.resolve(v); }
    else if (a === '--config') { const v = argv[++i]; if (v == null) return { error: '--config requires a path' }; opts.configPath = path.resolve(v); }
    else if (a === '--no-default') opts.configPath = null;
    else if (a === '--since')  { const v = argv[++i]; if (v == null) return { error: '--since requires an ISO timestamp' }; opts.since = Date.parse(v); }
    else if (a === '--json')   opts.json = true;
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else return { error: `unknown argument: ${a}` };
  }
  if (opts.since != null && Number.isNaN(opts.since)) return { error: 'invalid --since timestamp' };
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: verify-effective-model.cjs [--db PATH] [--since ISO] [--agents DIR] [--config PATH] [--no-default] [--json]');
    return 0;
  }

  const result = verify(opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.error) {
    console.error(`  ✗  effective-model check failed — ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  effective-model check skipped — ${result.skipped}`);
  } else {
    const window = opts.since == null ? 'all time' : `since ${new Date(opts.since).toISOString()}`;
    console.log(`effective-model vs tier pin (${window})`);
    for (const [id, s] of Object.entries(result.agents)) {
      const seen = Object.entries(s.models)
        .sort((a, b) => b[1] - a[1])
        .map(([m, n]) => `${m}×${n}`)
        .join(', ');
      const bad = s.unrouted + s['wrong-tier'] + s.unparseable;
      const mark = bad > 0 ? '✗' : '✓';
      const intent = `${s.intended.providerID}/${s.intended.id}`;
      const label = s.default ? `${id} (default)` : id;
      console.log(
        `  ${mark}  ${label} → ${intent}  ` +
          `[ok ${s.ok}, unrouted ${s.unrouted}, wrong-tier ${s['wrong-tier']}, ` +
          `off-provider ${s['off-provider']}, unparseable ${s.unparseable}]` +
          (seen ? `  { ${seen} }` : ''),
      );
    }
    if (result.totals.graded === 0) {
      console.log('  ~  no graded sessions in this window');
    }
  }

  if (result.error) return 1;   // present but unreadable store: fail loud
  if (result.skipped) return 0; // absent store: inert
  return result.drift > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  parseFrontmatter, intendedModels, classify,
  readDefaultAgent, isSelectable,
  readSessions, parseModel, verify, parseArgs, main,
};
