#!/usr/bin/env node
/**
 * measure-compaction.cjs
 *
 * A read-only instrument for the compaction overlay (`install/opencode/
 * config.jsonc`, the `compaction` block). The config comment records that block
 * as "no repo ruler yet ... Accepted defaults, not yet measured"; this is that
 * ruler. It is the same inertia-clearing instrument shape as n=12 (retained
 * tool-output bytes), n=13 (read-back effect), and n=16 (failure composition):
 * turn a hand-waved default into a number the loop can act on.
 *
 * OpenCode v2 stores every compaction as a `session_message` row of
 * `type='compaction'`. The `data` JSON is host-owned and carries two vintages:
 *
 *   - the base shape (all rows): `time.created`, `status`
 *     (completed/running/failed), `reason` (auto/manual), `summary` (the
 *     produced summary text), `recent` (the preserved tail the host `select()`
 *     returned), and, on failure, `error`.
 *   - a newer vintage (a subset of rows): additionally `model`, `cost`, and
 *     `tokens { input, output, reasoning, cache }`.
 *
 * MISLABELING WARNING (the reason this ruler exists rather than a one-liner):
 * `tokens.input` is NOT the session's trigger context size. It is the
 * SUMMARIZER CALL's own usage. Evidence: a real row pairs `input: 3` with
 * `cache.write: 490364`, so the summarizer prompt the provider billed is
 * `input + cache.read + cache.write`, not `input`. This ruler therefore reports
 * `tokens` only as the summarizer call's usage, on the rows that carry it, and
 * treats the schema-vintage split as a first-class coverage statistic. A ruler
 * that read `tokens.input` as "context at trigger" would be wrong by an order
 * of magnitude on the rows where the prompt came from cache.
 *
 * Read-only: opens the store `readOnly`, never writes, no config read, no
 * network. Absence of data is a graceful SKIP (exit 0); a present store with a
 * schema we cannot read is an error (exit 1), matching the sibling rulers.
 *
 * This is an instrument, not a decision: it reports what the overlay did, so a
 * later, measured iteration can decide whether to change a value. It never
 * scores and never writes.
 *
 * Usage:
 *   node install/lib/measure-compaction.cjs [--db PATH] [--since ISO]
 *        [--all] [--json]
 *
 * Exit codes: 0 = measured or skipped, 1 = error (present-but-unreadable store),
 * 2 = usage error.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Parse a JSON string, returning `null` (never throwing) on malformed input. */
function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Normalise one `type='compaction'` row's `data` JSON to the fields the ruler
 * uses. Returns `null` for a non-object (a malformed row), so the caller can
 * fail loud. `hasUsage` marks the newer vintage; `usage` carries `tokens` only
 * when present (the SUMMARIZER call's usage, see the header).
 */
function compactionFromRow(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const tk = d.tokens && typeof d.tokens === 'object' ? d.tokens : null;
  const model = d.model && typeof d.model.id === 'string' ? d.model.id : null;
  const hasUsage = tk !== null || model !== null || typeof d.cost === 'number';
  return {
    status:     typeof d.status === 'string' ? d.status : 'unknown',
    reason:     typeof d.reason === 'string' ? d.reason : 'unknown',
    hasUsage,
    usage:      tk,                      // summarizer-call usage, or null
    model,
    cost:       typeof d.cost === 'number' ? d.cost : null,
    summaryLen: typeof d.summary === 'string' ? d.summary.length : 0,
    recentLen:  typeof d.recent === 'string' ? d.recent.length : 0,
    hasRecent:  typeof d.recent === 'string' && d.recent.length > 0,
    t:          d.time && typeof d.time.created === 'number' ? d.time.created : null,
  };
}

/**
 * The `p`-quantile of `values` (linear interpolation, the R-7 default), or
 * `null` when there are no finite numbers. Sorts a copy, so it never mutates.
 */
function quantile(values, p) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const i = (xs.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
}

/** Increment `m[key]` in a plain-object counter. Pure-ish (mutates `m`). */
function bump(m, key) { m[key] = (m[key] || 0) + 1; }

/**
 * Summarise normalised compaction rows. Each row may carry `agent` (joined from
 * the session table). Returns coverage, the reliability splits, the schema
 * vintage, the summarizer-usage quantiles, the per-agent split, and the
 * per-session thrash distribution.
 */
function summarize(compactions) {
  const rows = compactions.length;
  const byReason = {};
  const byStatus = {};
  const byAgent = {};
  const usageByModel = {};
  const inputs = [];
  const recentChars = [];
  const perSession = new Map();
  let withUsage = 0;
  let withRecent = 0;
  let costs = 0;

  for (const c of compactions) {
    bump(byReason, c.reason);
    bump(byStatus, c.status);
    bump(byAgent, c.agent || 'unknown');
    if (c.hasUsage) withUsage += 1;
    if (c.usage && typeof c.usage.input === 'number') inputs.push(c.usage.input);
    if (c.model) bump(usageByModel, c.model);
    if (typeof c.cost === 'number') costs += c.cost;
    if (c.hasRecent) { withRecent += 1; recentChars.push(c.recentLen); }
    const sid = c.session || '(none)';
    perSession.set(sid, (perSession.get(sid) || 0) + 1);
  }

  const thrashCounts = [...perSession.values()];
  const buckets = { one: 0, twoToFour: 0, fiveToNine: 0, tenPlus: 0 };
  for (const n of thrashCounts) {
    if (n <= 1) buckets.one += 1;
    else if (n <= 4) buckets.twoToFour += 1;
    else if (n <= 9) buckets.fiveToNine += 1;
    else buckets.tenPlus += 1;
  }

  const rate = (n) => (rows > 0 ? n / rows : 0);
  const q = (arr, ps) => (arr.length === 0 ? null : Object.fromEntries(ps.map((p) => [`p${p}`, quantile(arr, p / 100)])));

  return {
    rows,
    sessions: perSession.size,
    byReason,
    byStatus,
    withUsage,
    usageRate: rate(withUsage),
    // Summarizer-call usage (see the header), not trigger context.
    usageTokenQuantiles: q(inputs, [25, 50, 90]),
    usageMaxInput: inputs.length ? Math.max(...inputs) : null,
    usageByModel,
    withRecent,
    recentRate: rate(withRecent),
    recentCharQuantiles: q(recentChars, [10, 25, 50, 75, 90]),
    byAgent,
    totalCost: costs,
    thrash: {
      median: quantile(thrashCounts, 0.5),
      p90: quantile(thrashCounts, 0.9),
      max: thrashCounts.length ? Math.max(...thrashCounts) : 0,
      buckets,
    },
  };
}

// ─── Store access (read-only, skip-vs-error semantics) ───────────────────────

/**
 * Read compaction rows from the store. Compaction is a v2 concept, so this
 * reads `session_message` with `type='compaction'` and left-joins the session's
 * `agent` from `session_v2` (falling back to the legacy `session`). Returns
 * `{ compactions, skipped, error }` with the sibling rulers' contract: absent
 * store/table -> skipped; present but unreadable -> error; any unparseable row
 * -> error (a malformed row must fail loud, not silently under-count).
 */
function readCompactions(dbPath, since) {
  if (!fs.existsSync(dbPath)) return { compactions: [], skipped: `no store at ${dbPath}`, error: null };
  let sqlite;
  try { sqlite = require('node:sqlite'); }
  catch { return { compactions: [], skipped: 'node:sqlite unavailable in this runtime', error: null }; }

  let db;
  try { db = new sqlite.DatabaseSync(dbPath, { readOnly: true }); }
  catch (err) { return { compactions: [], skipped: null, error: `cannot open store: ${err.message}` }; }

  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    if (!tables.has('session_message')) return { compactions: [], skipped: 'no session_message table', error: null };

    // Agent per session, from whichever session table exists. A schema
    // mismatch degrades gracefully (agent unknown), never an error: the
    // compaction evidence is in the message store regardless.
    const agentBySession = new Map();
    const sessionTable = tables.has('session_v2') ? 'session_v2' : (tables.has('session') ? 'session' : null);
    if (sessionTable) {
      try {
        for (const r of db.prepare(`SELECT id, agent FROM ${sessionTable}`).all()) {
          if (r.agent) agentBySession.set(r.id, r.agent);
        }
      } catch { /* session table shape drift: agent split stays 'unknown' */ }
    }

    const where  = ["type = 'compaction'", 'data IS NOT NULL'];
    const params = [];
    if (since != null) { where.push('time_created > ?'); params.push(since); }
    const rows = db
      .prepare(`SELECT session_id, data, time_created FROM session_message WHERE ${where.join(' AND ')}`)
      .all(...params);

    const compactions = [];
    const unparseable = [];
    for (const r of rows) {
      const c = compactionFromRow(r.data);
      if (c == null) { unparseable.push(r.session_id); continue; }
      compactions.push({ ...c, session: r.session_id, agent: agentBySession.get(r.session_id) || 'unknown' });
    }
    if (unparseable.length > 0) {
      return { compactions: [], skipped: null, error: `${unparseable.length} store row(s) unparseable (format drift)` };
    }
    return { compactions, skipped: null, error: null };
  } catch (err) {
    return { compactions: [], skipped: null, error: `query failed: ${err.message}` };
  } finally {
    db.close();
  }
}

/** Full measurement used by the CLI: read + summarize, preserving skip/error. */
function measure(options = {}) {
  const { compactions, skipped, error } = readCompactions(options.dbPath, options.since);
  if (error) return { skipped: null, error };
  if (skipped) return { skipped, error: null };
  return { skipped: null, error: null, ...summarize(compactions) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 30;

function parseArgs(argv) {
  const opts = {
    dbPath: path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    since:  null,
    all:    false,
    json:   false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db')         { const v = argv[++i]; if (v == null) return { error: '--db requires a path' }; opts.dbPath = v; }
    else if (a === '--since') { const v = argv[++i]; if (v == null) return { error: '--since requires an ISO timestamp' }; opts.since = Date.parse(v); }
    else if (a === '--all')   opts.all = true;
    else if (a === '--json')  opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (opts.since != null && Number.isNaN(opts.since)) return { error: 'invalid --since timestamp' };
  if (opts.all) opts.since = null;
  else if (opts.since == null) opts.since = Date.now() - DEFAULT_WINDOW_DAYS * 864e5;
  return opts;
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: measure-compaction.cjs [--db PATH] [--since ISO] [--all] [--json]');
    return 0;
  }

  const result = measure(opts);

  if (opts.json) {
    console.log(JSON.stringify({ since: opts.since == null ? null : new Date(opts.since).toISOString(), ...result }, null, 2));
  } else if (result.error) {
    console.error(`  \u2717  compaction ruler failed \u2014 ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  compaction ruler skipped \u2014 ${result.skipped}`);
  } else {
    const window = opts.since == null ? 'all time' : `since ${new Date(opts.since).toISOString()}`;
    console.log(`compaction overlay (${window})`);
    console.log(`  ${result.rows} compaction(s) over ${result.sessions} session(s)`);
    const reasons = Object.entries(result.byReason).map(([k, n]) => `${k} ${n}`).join(', ');
    const statuses = Object.entries(result.byStatus).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  reason: ${reasons || '(none)'}`);
    console.log(`  status: ${statuses || '(none)'}`);
    console.log(`  schema vintage: ${result.withUsage} with usage (${pct(result.usageRate)}), ${result.rows - result.withUsage} without`);
    if (result.usageTokenQuantiles) {
      const u = result.usageTokenQuantiles;
      console.log(`  summarizer-call input tokens (NOT trigger context): p25 ${u.p25}, p50 ${u.p50}, p90 ${u.p90}, max ${result.usageMaxInput}`);
    }
    const agents = Object.entries(result.byAgent).map(([k, n]) => `${k}\u00d7${n}`).join(', ');
    if (agents) console.log(`  by agent: ${agents}`);
    console.log(`  per-session thrash: median ${result.thrash.median}, p90 ${result.thrash.p90}, max ${result.thrash.max} (once ${result.thrash.buckets.one}, 2-4 ${result.thrash.buckets.twoToFour}, 5-9 ${result.thrash.buckets.fiveToNine}, 10+ ${result.thrash.buckets.tenPlus})`);
    if (result.rows === 0) console.log('  ~  no compactions in this window');
  }

  if (result.error) return 1;
  return 0;
}

module.exports = {
  safeJson,
  compactionFromRow,
  quantile,
  summarize,
  readCompactions,
  measure,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
