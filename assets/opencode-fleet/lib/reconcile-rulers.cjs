#!/usr/bin/env node
/**
 * reconcile-rulers.cjs
 *
 * A read-only reconciliation gate for the store-census rulers. The playbook's
 * instrument-discipline line (L041, L043) says a number the loop routes on must
 * come from a command, and the loop's own audit (n=38 → n=44) showed a ruler can
 * carry a predicate defect for iterations because nothing INDEPENDENTLY checked
 * its headline. Each census ruler reads the store with hand-written JS
 * (`JSON.parse` + an array/object walk); this gate reads the SAME store with a
 * DIFFERENT mechanism — SQLite's JSON1 functions (`json_each`/`json_extract`)
 * driven by declarative SQL — and asserts the two agree on the ruler's headline
 * scalars. A divergence means one of the two misreads the store: a drifted table
 * name, column, JSON path, window filter, or unit definition.
 *
 * Scope, honestly: this catches MECHANISM drift (the ruler and its independent
 * query disagree), not SPECIFICATION error (both encode the same wrong
 * definition). A predicate defect that is faithfully re-expressed in the oracle
 * reconciles clean — that class needs the human/reviewer, and the n=44 record
 * says so. This gate is the mechanical half.
 *
 * Independence, concretely: the oracle never requires the ruler's module. It
 * opens the store and runs SQL. It does NOT reuse the ruler's parser, its table
 * preference logic, or its tie-breaks (the failure oracle specifies "latest
 * idle row by `seq`, then `rowid`, wins" in SQL; the ruler's Map happens to
 * agree — a divergence here is exactly the signal this gate exists to surface).
 *
 * Read-only: opens the store `readOnly`, never writes, no config read, no
 * network. Reads MACHINE state on purpose, so the commit-time gate runs only the
 * fixture suite (see `.githooks/pre-commit` Layer 24), never this ruler against
 * the live store. Absence of data is a graceful SKIP (exit 0); a present store
 * with a schema the oracle cannot read is a SKIP-for-that-ruler with a reason,
 * not a false mismatch; an actual headline divergence, OR a ruler/oracle that
 * could not be read (an error status), is exit 1.
 *
 * Usage:
 *   node install/lib/reconcile-rulers.cjs [--db PATH] [--since ISO] [--all] [--json]
 *
 * Exit codes: 0 = every ruler reconciled or skipped; 1 = a mismatch, an error
 * status (ruler-error/oracle-error), or a store error; 2 = usage error. An error
 * status must NOT exit 0: a ruler that stops running is exactly the drift class
 * this gate exists to surface, so it must fail the gate rather than pass it green.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const DEFAULT_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// ─── Independent SQL oracles (JSON1; never require a ruler module) ───────────

/** Does the store expose a table with this name? */
function hasTable(db, name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/**
 * failure-composition headline: `failures` and `recovered`.
 * Oracle semantics stated declaratively: the terminal outcome is the latest
 * `idle`-row outcome (by `seq`, then `rowid` as a deterministic tie-break), else
 * `session_v2.idle_outcome`; a session is a failure when its outcome is
 * failed/interrupted, or (outcome unknown) it carries an error-state tool unit;
 * a session is recovered when its outcome is succeeded AND it carries an
 * error-state tool unit. The session set is the union of sessions with a
 * `session_message` row in-window and every `session_v2` row, matching the
 * ruler's own set (it enriches outcomes from all of `session_v2` regardless of
 * the window), so the window filter is applied to the message side only.
 */
function oracleFailure(db, since) {
  if (!hasTable(db, 'session_message')) return { unsupported: 'no session_message table' };
  const hasV2 = hasTable(db, 'session_v2');
  // Filter the base table inline (never carry `data` through a bulk CTE): at
  // `--all` a CTE holding every row's JSON blob blows memory on a large store.
  const winIdle = since != null ? ' AND time_created > ?' : '';
  const winIds  = since != null ? ' WHERE time_created > ?' : '';
  const winErr  = since != null ? ' AND m.time_created > ?' : '';
  const v2Union = hasV2 ? ' UNION SELECT id FROM session_v2' : '';
  const v2Out   = hasV2 ? "(SELECT NULLIF(idle_outcome,'') FROM session_v2 WHERE session_v2.id=i.id)" : 'NULL';
  const sql = `
    WITH idleout AS (
      SELECT session_id id, COALESCE(json_extract(data,'$.outcome'), json_extract(data,'$.status')) o
      FROM (
        SELECT session_id, data, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC, rowid DESC) rn
        FROM session_message WHERE type='idle' AND data IS NOT NULL${winIdle}
      ) WHERE rn = 1
    ),
    ids AS (SELECT DISTINCT session_id id FROM session_message${winIds}${v2Union}),
    outc AS (
      SELECT i.id,
        COALESCE((SELECT o FROM idleout WHERE idleout.id = i.id AND o IS NOT NULL), ${v2Out}) outcome
      FROM ids i
    ),
    errs AS (
      SELECT DISTINCT m.session_id id FROM session_message m, json_each(m.data,'$.content') je
      WHERE m.type = 'assistant' AND m.data LIKE '%"error"%'${winErr}
        AND json_extract(je.value,'$.state.status') = 'error'
    )
    SELECT
      SUM(CASE WHEN o.outcome IN ('failed','interrupted') OR (o.outcome IS NULL AND e.id IS NOT NULL) THEN 1 ELSE 0 END) failures,
      SUM(CASE WHEN o.outcome = 'succeeded' AND e.id IS NOT NULL THEN 1 ELSE 0 END) recovered
    FROM outc o LEFT JOIN errs e ON e.id = o.id`;
  const params = since != null ? [since, since, since] : [];
  const r = db.prepare(sql).get(...params);
  return { failures: r.failures || 0, recovered: r.recovered || 0 };
}

/**
 * permission-friction headline: `denials` (tool-call units) and `sessions`
 * (distinct sessions carrying >=1). Oracle: one `json_each` element per
 * content item, keep the items that are structural denials
 * (`state.error.type === 'permission.rejected'`), count units and distinct
 * sessions.
 */
function oracleFriction(db, since) {
  if (!hasTable(db, 'session_message')) return { unsupported: 'no session_message table' };
  const sql = `
    SELECT COUNT(*) denials, COUNT(DISTINCT m.session_id) sessions
    FROM session_message m, json_each(m.data,'$.content') je
    WHERE m.data LIKE '%permission.rejected%'
      AND json_extract(je.value,'$.state.status') = 'error'
      AND json_extract(je.value,'$.state.error.type') = 'permission.rejected'${since != null ? ' AND m.time_created > ?' : ''}`;
  const params = since != null ? [since] : [];
  const r = db.prepare(sql).get(...params);
  return { denials: r.denials || 0, sessions: r.sessions || 0 };
}

/**
 * compaction headline: `rows` (compaction messages) and `sessions` (distinct
 * sessions with >=1). Oracle: a plain row count and a distinct-session count on
 * the `type='compaction'` predicate.
 */
function oracleCompaction(db, since) {
  if (!hasTable(db, 'session_message')) return { unsupported: 'no session_message table' };
  const sql = `
    SELECT COUNT(*) rows, COUNT(DISTINCT session_id) sessions
    FROM session_message
    WHERE type = 'compaction' AND data IS NOT NULL${since != null ? ' AND time_created > ?' : ''}`;
  const params = since != null ? [since] : [];
  const r = db.prepare(sql).get(...params);
  return { rows: r.rows || 0, sessions: r.sessions || 0 };
}

// ─── Ruler registry (lazy requires; the oracle is independent) ───────────────

const RULERS = [
  {
    name: 'failure-composition',
    module: () => require('./measure-failure-composition.cjs'),
    headline: (r) => ({ failures: r.failures, recovered: r.recovered }),
    oracle: oracleFailure,
  },
  {
    name: 'permission-friction',
    module: () => require('./measure-permission-friction.cjs'),
    headline: (r) => ({ denials: r.denials, sessions: r.sessions }),
    oracle: oracleFriction,
  },
  {
    name: 'compaction',
    module: () => require('./measure-compaction.cjs'),
    headline: (r) => ({ rows: r.rows, sessions: r.sessions }),
    oracle: oracleCompaction,
  },
];

// ─── Pure comparison ─────────────────────────────────────────────────────────

/**
 * Compare a ruler's headline scalars to the oracle's, key by key. Returns
 * `{ ok, mismatches: [{ metric, ruler, oracle }] }`. Pure: the caller supplies
 * both sides, so a drifted ruler can be tested without a store.
 */
function compareHeadline(rulerHeadline, oracleHeadline) {
  const mismatches = [];
  for (const k of Object.keys(oracleHeadline)) {
    if (rulerHeadline[k] !== oracleHeadline[k]) {
      mismatches.push({ metric: k, ruler: rulerHeadline[k], oracle: oracleHeadline[k] });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ─── Store access ────────────────────────────────────────────────────────────

/**
 * Reconcile every registered ruler against its independent oracle over one
 * `since` window. `entries` defaults to `RULERS` (injectable for fixtures).
 * Returns `{ rows, skipped, error }` where `rows` is
 * `[{ name, status, ruler, oracle, mismatches, reason }]` and `status` is one of
 * `ok` (reconciled), `mismatch`, `skip` (cannot compare, with a reason), or
 * `ruler-error` / `oracle-error`. The oracle runs first per ruler, so when the
 * store itself is unreadable the row is classified `skip`/`oracle-error` and the
 * ruler is not invoked: a simultaneous ruler failure is masked by design, since
 * an unreadable store already fails the gate.
 */
function reconcile(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB;
  const entries = options.entries || RULERS;
  const since = options.since ?? null;

  if (!fs.existsSync(dbPath)) return { rows: [], skipped: `no store at ${dbPath}`, error: null };
  let sqlite;
  try { sqlite = require('node:sqlite'); }
  catch { return { rows: [], skipped: 'node:sqlite unavailable in this runtime', error: null }; }

  let db;
  try { db = new sqlite.DatabaseSync(dbPath, { readOnly: true }); }
  catch (err) { return { rows: [], skipped: null, error: `cannot open store: ${err.message}` }; }

  try {
    const rows = [];
    for (const e of entries) {
      const row = { name: e.name, status: 'skip', ruler: null, oracle: null, mismatches: [], reason: null };
      let oracleHead = null;
      try { oracleHead = e.oracle(db, since); }
      catch (err) { row.status = 'oracle-error'; row.reason = err.message; rows.push(row); continue; }
      if (oracleHead && oracleHead.unsupported) { row.reason = oracleHead.unsupported; rows.push(row); continue; }

      let result;
      try { result = e.module().measure({ dbPath, since }); }
      catch (err) { row.status = 'ruler-error'; row.reason = err.message; rows.push(row); continue; }
      if (result.error) { row.status = 'ruler-error'; row.reason = result.error; rows.push(row); continue; }
      if (result.skipped) { row.status = 'skip'; row.reason = result.skipped; rows.push(row); continue; }

      const rulerHead = e.headline(result);
      row.ruler = rulerHead;
      row.oracle = oracleHead;
      const cmp = compareHeadline(rulerHead, oracleHead);
      row.status = cmp.ok ? 'ok' : 'mismatch';
      row.mismatches = cmp.mismatches;
      rows.push(row);
    }
    return { rows, skipped: null, error: null };
  } catch (err) {
    return { rows: [], skipped: null, error: `query failed: ${err.message}` };
  } finally {
    db.close();
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 30;

function parseArgs(argv) {
  const opts = { dbPath: DEFAULT_DB, since: null, all: false, json: false };
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

/**
 * The process exit code for a `reconcile()` result. Pure, so a fixture can pin
 * the contract without spawning a process. `0` only when every ruler reconciled
 * (`ok`) or was skipped for a benign reason; `1` on a store-level error, a
 * headline mismatch, or a per-ruler read error (a ruler that stopped being
 * readable must fail the gate, not pass it green).
 */
function exitCodeFor(result) {
  if (result.error) return 1;
  if (result.rows.some((r) => r.status === 'mismatch' || r.status === 'ruler-error' || r.status === 'oracle-error')) return 1;
  return 0;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: reconcile-rulers.cjs [--db PATH] [--since ISO] [--all] [--json]');
    return 0;
  }

  const result = reconcile(opts);
  const window = opts.since == null ? 'all time' : `since ${new Date(opts.since).toISOString()}`;

  if (opts.json) {
    console.log(JSON.stringify({ since: opts.since == null ? null : new Date(opts.since).toISOString(), ...result }, null, 2));
  } else if (result.error) {
    console.error(`  \u2717  ruler reconciliation failed \u2014 ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  ruler reconciliation skipped \u2014 ${result.skipped}`);
  } else {
    console.log(`ruler reconciliation (${window})`);
    for (const r of result.rows) {
      const pair = r.ruler ? ` ${JSON.stringify(r.ruler)}` : '';
      const reason = r.reason ? ` \u2014 ${r.reason}` : '';
      const mark = r.status === 'ok' ? '\u2713' : (r.status === 'skip' ? '~' : '\u2717');
      console.log(`  ${mark}  ${r.name}: ${r.status}${pair}${reason}`);
      for (const m of r.mismatches) console.log(`      ${m.metric}: ruler ${m.ruler} vs oracle ${m.oracle}`);
    }
  }

  return exitCodeFor(result);
}

module.exports = {
  hasTable,
  oracleFailure,
  oracleFriction,
  oracleCompaction,
  RULERS,
  compareHeadline,
  reconcile,
  exitCodeFor,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
