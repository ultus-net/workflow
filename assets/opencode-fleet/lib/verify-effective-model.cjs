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
 * overlay agent frontmatter (`install/opencode/agents/*.md`). Only agents with
 * an explicit pin are graded; unpinned agents (built-ins, strangers) are not.
 *
 * Classification of an effective model for a pinned agent:
 *   ok           — synthetic provider and the exact intended alias
 *   unrouted     — synthetic/syn:auto (the router/pin did not take effect)
 *   wrong-tier   — another synthetic alias (e.g. small where large is intended)
 *   off-provider — not synthetic at all (OpenRouter/Azure failover is legitimate)
 *   unparseable  — the `model` column is not a JSON object (format drift /
 *                  corruption). This is DRIFT, not failover: bucketing it as
 *                  off-provider would let a store-format change turn the ruler
 *                  green forever. A malformed row must fail loud.
 *
 * Exit codes: 0 = no drift (ok/off-provider only), 1 = drift
 * (unrouted/wrong-tier/unparseable), a present-but-unreadable store, or an
 * unreadable/empty intent source (bad `--agents` dir, no pinned agents), 2 =
 * usage error. A missing store or absent `session_v2` table is a graceful SKIP
 * (exit 0): the tool is inert where there is no database to measure, never a
 * spurious failure. Absence of data is a skip; presence of unreadable data (bad
 * query, missing columns, malformed rows) is a failure. The same split applies
 * to the intent source: a missing/unreadable `--agents` dir, or one that yields
 * no pinned agents, is an error, not a clean run — otherwise a typo would grade
 * nothing and exit 0.
 *
 * Usage:
 *   node install/lib/verify-effective-model.cjs [--db PATH] [--since ISO]
 *        [--agents DIR] [--json]
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

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

/** Classify one effective model against its intended target. */
function classify(effective, intended) {
  if (!intended) return 'no-intent';
  if (effective === null) return 'unparseable';
  if (effective.providerID !== SYNTHETIC) return 'off-provider';
  if (effective.id === intended.id) return 'ok';
  if (effective.id === AUTO_ID) return 'unrouted';
  return 'wrong-tier';
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
 * Compare effective session models to intended pins.
 * Returns `{ agents, drift, skipped, error, totals }` where `agents` is keyed by
 * agent id and each entry lists per-classification counts, distinct models seen,
 * cost and tokens. `error` is non-null when the store is present-but-unreadable
 * or the intent source is unusable (bad/empty `agentsDir`); a `readSessions`
 * error takes precedence over the intent-source error.
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

  const agents = {};
  for (const id of Object.keys(intended)) {
    agents[id] = { intended: intended[id], ok: 0, unrouted: 0, 'wrong-tier': 0, 'off-provider': 0, unparseable: 0, models: {}, cost: 0, tokens: 0 };
  }

  for (const row of rows) {
    const spec = agents[row.agent];
    if (!spec) continue; // not a pinned fleet agent
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
  return { agents, drift, skipped, error: error ?? dirError, totals: { graded, intendedAgents: Object.keys(intended).length } };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    dbPath:   path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    agentsDir: path.resolve(__dirname, '..', 'opencode', 'agents'),
    since:    null,
    json:     false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db')          { const v = argv[++i]; if (v == null) return { error: '--db requires a path' }; opts.dbPath = v; }
    else if (a === '--agents') { const v = argv[++i]; if (v == null) return { error: '--agents requires a directory' }; opts.agentsDir = path.resolve(v); }
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
    console.log('usage: verify-effective-model.cjs [--db PATH] [--since ISO] [--agents DIR] [--json]');
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
      console.log(
        `  ${mark}  ${id} → ${s.intended.providerID}/${s.intended.id}  ` +
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

module.exports = { parseFrontmatter, intendedModels, classify, readSessions, parseModel, verify, main };
