#!/usr/bin/env node
/**
 * measure-failure-composition.cjs
 *
 * A read-only instrument for the Evaluate phase, from 2610.11655 ("Harness
 * Evolution Hits a Ceiling"). The lever a self-improvement loop should pull
 * depends on WHY the agent failed, so label each failed trajectory by the
 * FIRST signal that fires:
 *
 *   - process failures — a blocked/permission-denied call, an exhausted step
 *     budget, or a repeated-error loop. These are harness-fixable, and the
 *     behaviour the fix instils can later be trained into weights.
 *   - content failures — a plan that was delivered but is poor, with no
 *     process signal. The harness cannot fix these; they are what weight
 *     training is for.
 *
 * OpenCode v2 stores the evidence in `session_message` (v2) with a legacy
 * `part` fallback: assistant rows carry tool parts whose `state.status ===
 * "error"` and `state.error.type` distinguishes permission rejections from
 * execution errors; the session's terminal outcome lives on `session_v2
 * .idle_outcome` or an `idle`-type row's `.outcome`.
 *
 * The terminal outcome is authoritative: a session whose outcome is
 * `succeeded` is NOT a failure even though it carries error units (it
 * recovered), and it is reported in the `recovered` bucket so the population
 * stays visible. The error-unit fallback applies only to sessions with no
 * recorded outcome, preserving coverage of rows the store never marked
 * (n=38 audit; `docs/agents/findings/failure-composition-recovered-sessions.md`).
 *
 * Read-only: opens the store `readOnly`, never writes, no config read, no
 * network. Absence of data is a graceful SKIP (exit 0); a present store with a
 * schema we cannot read is an error (exit 1), matching the other rulers.
 *
 * This is an instrument, not a decision: it reports the process/content split
 * so the loop can route a candidate to a harness edit or to weight training.
 * It never scores and never writes.
 *
 * Usage:
 *   node install/lib/measure-failure-composition.cjs [--db PATH] [--since ISO]
 *        [--all] [--json]
 *
 * Exit codes: 0 = measured or skipped, 1 = error (present-but-unreadable store),
 * 2 = usage error.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ─── Signal predicates (exported for tests) ──────────────────────────────────

// A permission denial / blocked call. `state.error.type` is the structural form;
// the substrings cover the text forms the guard and host emit.
const PERMISSION_TYPE = 'permission.rejected';
const PERMISSION_RE   = /PermissionDenied|permission\.rejected|\[workflow-guard\] Blocked:/;
// Step-budget exhaustion (the agent ran out of `steps`).
const STEP_BUDGET_RE  = /maximum number of steps|Steps exhausted/i;
// A repeated-error loop fires when the SAME error message recurs this often.
const REPEATED_ERROR_THRESHOLD = 3;

// ─── Pure detection helpers (exported for tests) ─────────────────────────────

/** Parse a JSON string, returning `null` (never throwing) on malformed input. */
function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Normalise one tool part to the fields the classifier uses. `text` is the
 * error message when present, else the output, else the part text — the blob
 * the string predicates scan.
 */
function normalizeToolPart(part) {
  if (!part || part.type !== 'tool') return null;
  const state = part.state || {};
  const err   = state.error || {};
  const text  = typeof err.message === 'string' ? err.message
              : typeof state.output === 'string' ? state.output
              : typeof part.text === 'string' ? part.text : '';
  return {
    kind:      'tool',
    tool:      part.name || part.tool || 'unknown',
    status:    state.status || null,
    errorType: err.type || null,
    text,
  };
}

/**
 * Evidence units from a `session_message` row's `data` JSON: tool parts (with
 * error state) plus text parts (so an injected step-limit notice in a text
 * part is still seen). Malformed input yields [].
 */
function unitsFromSessionMessage(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  if (!d || !Array.isArray(d.content)) return [];
  const out = [];
  for (const it of d.content) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'tool') {
      const n = normalizeToolPart(it);
      if (n) out.push(n);
    } else if (typeof it.text === 'string' && it.text !== '') {
      out.push({ kind: it.type || 'text', tool: it.type || 'text', status: null, errorType: null, text: it.text });
    }
  }
  return out;
}

/** Evidence units from a legacy `part` row's `data` JSON (the part object itself). */
function unitsFromLegacyPart(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  if (!d || typeof d !== 'object') return [];
  if (d.type === 'tool') {
    const n = normalizeToolPart(d);
    return n ? [n] : [];
  }
  if (typeof d.text === 'string' && d.text !== '') {
    return [{ kind: d.type || 'text', tool: d.type || 'text', status: null, errorType: null, text: d.text }];
  }
  return [];
}

/** The terminal outcome of a session from an `idle` row's `data` JSON. */
function outcomeFromIdleData(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  if (!d || typeof d !== 'object') return null;
  const o = d.outcome ?? d.status ?? null;
  return typeof o === 'string' ? o : null;
}

/**
 * Every process signal in a session's evidence units, each with the time it
 * fired. Ordered by fire time, then a stable precedence (permission >
 * step-budget > error-loop) so a tie is deterministic.
 */
const SIGNAL_ORDER = { permission: 0, 'step-budget': 1, 'error-loop': 2 };
function sessionSignals(units) {
  const signals = [];
  for (const u of units) {
    if (u.status !== 'error') {
      // A step-limit notice can arrive as a non-error text part; still a signal.
      if (STEP_BUDGET_RE.test(u.text || '')) signals.push({ signal: 'step-budget', t: u.t ?? 0 });
      continue;
    }
    const blob = u.text || '';
    if (u.errorType === PERMISSION_TYPE || PERMISSION_RE.test(blob)) signals.push({ signal: 'permission', t: u.t ?? 0 });
    if (STEP_BUDGET_RE.test(blob)) signals.push({ signal: 'step-budget', t: u.t ?? 0 });
  }
  // A repeated-error loop fires at the Nth occurrence of an identical message.
  const byText = new Map();
  for (const u of units) {
    if (u.status !== 'error' || !u.text) continue;
    if (!byText.has(u.text)) byText.set(u.text, []);
    byText.get(u.text).push(u.t ?? 0);
  }
  for (const times of byText.values()) {
    if (times.length >= REPEATED_ERROR_THRESHOLD) {
      times.sort((a, b) => a - b);
      signals.push({ signal: 'error-loop', t: times[REPEATED_ERROR_THRESHOLD - 1] });
    }
  }
  signals.sort((a, b) => (a.t - b.t) || (SIGNAL_ORDER[a.signal] - SIGNAL_ORDER[b.signal]));
  return signals;
}

/**
 * Classify one failed session by the FIRST signal that fires. A process signal
 * anywhere makes the session a process failure (the harness can fix it);
 * otherwise it is a content failure (weights are the lever).
 */
function classifySession(session) {
  const signals = sessionSignals(session.units || []);
  if (signals.length > 0) return { cls: 'process', signal: signals[0].signal };
  return { cls: 'content', signal: 'content' };
}

/**
 * Is this session a failure? The terminal outcome is authoritative: a session
 * that ended `succeeded` is not a failure even if it hit an error unit (it
 * recovered). `failed`/`interrupted` is a failure regardless of units. When
 * the outcome is unknown (null), the error-unit evidence is the fallback, so a
 * session the store never marked still counts if it carries an error.
 */
function isFailureSession(session) {
  if (session.outcome === 'succeeded') return false;
  if (session.outcome === 'failed' || session.outcome === 'interrupted') return true;
  return (session.units || []).some((u) => u.status === 'error');
}

/**
 * Did this session recover? True when it ended `succeeded` but carries at
 * least one error-state unit — the population the pre-correction predicate
 * mis-counted as failures.
 */
function isRecoveredSession(session) {
  return session.outcome === 'succeeded' && (session.units || []).some((u) => u.status === 'error');
}

/**
 * Compose the failure split over assembled sessions. Each session is
 * `{ id, outcome, units }`. Returns the process/content counts, the per-signal
 * breakdown, the recovered count, and up to `cap` representative session ids
 * per class. `recovered` sessions are reported but not classified (they are
 * not failures).
 */
function analyze(sessions, cap = 10) {
  const bySignal = { permission: 0, 'step-budget': 0, 'error-loop': 0 };
  let process = 0;
  let content = 0;
  let recovered = 0;
  const processIds = [];
  const contentIds = [];
  for (const s of sessions) {
    if (isRecoveredSession(s)) recovered += 1;
    if (!isFailureSession(s)) continue;
    const r = classifySession(s);
    if (r.cls === 'process') {
      process += 1;
      bySignal[r.signal] += 1;
      if (processIds.length < cap) processIds.push(s.id);
    } else {
      content += 1;
      if (contentIds.length < cap) contentIds.push(s.id);
    }
  }
  const failures = process + content;
  return {
    failures,
    process,
    content,
    recovered,
    processRate: failures > 0 ? process / failures : 0,
    contentRate: failures > 0 ? content / failures : 0,
    bySignal,
    representatives: { process: processIds, content: contentIds },
  };
}

// ─── Store access (read-only, skip-vs-error semantics) ───────────────────────

/**
 * Read and assemble sessions from the store. Prefers the v2 `session_message`
 * table and falls back to the legacy `part` table. Terminal outcomes come from
 * `session_v2.idle_outcome` and/or `idle`-type rows; their absence degrades
 * gracefully (outcome unknown), it is not an error.
 *
 * Returns `{ sessions, skipped, error }` with the other rulers' contract:
 * absent store/table -> skipped; present but unreadable -> error.
 */
function readSessions(dbPath, since) {
  if (!fs.existsSync(dbPath)) return { sessions: [], skipped: `no store at ${dbPath}`, error: null };
  let sqlite;
  try { sqlite = require('node:sqlite'); }
  catch { return { sessions: [], skipped: 'node:sqlite unavailable in this runtime', error: null }; }

  let db;
  try { db = new sqlite.DatabaseSync(dbPath, { readOnly: true }); }
  catch (err) { return { sessions: [], skipped: null, error: `cannot open store: ${err.message}` }; }

  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    const v2 = tables.has('session_message');
    const legacy = tables.has('part');
    if (!v2 && !legacy) return { sessions: [], skipped: 'no session_message or part table', error: null };

    const unitsBySession = new Map();
    const outcomeBySession = new Map();
    const push = (sid, unit) => {
      if (!unitsBySession.has(sid)) unitsBySession.set(sid, []);
      unitsBySession.get(sid).push(unit);
    };
    const unparseable = [];

    if (v2) {
      const where  = ['data IS NOT NULL'];
      const params = [];
      if (since != null) { where.push('time_created > ?'); params.push(since); }
      const rows = db
        .prepare(`SELECT session_id, type, data, time_created FROM session_message WHERE ${where.join(' AND ')}`)
        .all(...params);
      for (const r of rows) {
        const d = safeJson(r.data);
        if (d == null) { unparseable.push(r.session_id); continue; }
        if (r.type === 'idle') {
          const o = outcomeFromIdleData(d);
          if (o) outcomeBySession.set(r.session_id, o);
          continue;
        }
        if (r.type !== 'assistant') continue;
        for (const u of unitsFromSessionMessage(d)) push(r.session_id, { ...u, t: r.time_created });
      }
    } else {
      const where  = ['data IS NOT NULL'];
      const params = [];
      if (since != null) { where.push('time_created > ?'); params.push(since); }
      const rows = db
        .prepare(`SELECT session_id, data, time_created FROM part WHERE ${where.join(' AND ')}`)
        .all(...params);
      for (const r of rows) {
        const d = safeJson(r.data);
        if (d == null) { unparseable.push(r.session_id); continue; }
        for (const u of unitsFromLegacyPart(d)) push(r.session_id, { ...u, t: r.time_created });
      }
    }

    // Enrich with session_v2.idle_outcome when that table/column exists. A
    // schema mismatch here degrades gracefully (outcome unknown), because the
    // message store already carries the error evidence the classifier needs.
    if (tables.has('session_v2')) {
      try {
        for (const r of db.prepare('SELECT id, idle_outcome FROM session_v2').all()) {
          if (r.idle_outcome && !outcomeBySession.has(r.id)) outcomeBySession.set(r.id, r.idle_outcome);
        }
      } catch { /* session_v2 shape drift: outcomes stay unknown */ }
    }

    if (unparseable.length > 0) {
      return { sessions: [], skipped: null, error: `${unparseable.length} store row(s) unparseable (format drift)` };
    }

    const ids = new Set([...unitsBySession.keys(), ...outcomeBySession.keys()]);
    const sessions = [...ids].map((id) => ({
      id,
      outcome: outcomeBySession.get(id) || null,
      units: unitsBySession.get(id) || [],
    }));
    return { sessions, skipped: null, error: null };
  } catch (err) {
    return { sessions: [], skipped: null, error: `query failed: ${err.message}` };
  } finally {
    db.close();
  }
}

/** Full measurement used by the CLI: read + analyze, preserving skip/error. */
function measure(options = {}) {
  const { sessions, skipped, error } = readSessions(options.dbPath, options.since);
  if (error) return { skipped: null, error };
  if (skipped) return { skipped, error: null };
  return { skipped: null, error: null, ...analyze(sessions) };
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
    console.log('usage: measure-failure-composition.cjs [--db PATH] [--since ISO] [--all] [--json]');
    return 0;
  }

  const result = measure(opts);

  if (opts.json) {
    console.log(JSON.stringify({ since: opts.since == null ? null : new Date(opts.since).toISOString(), ...result }, null, 2));
  } else if (result.error) {
    console.error(`  \u2717  failure-composition check failed \u2014 ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  failure-composition check skipped \u2014 ${result.skipped}`);
  } else {
    const window = opts.since == null ? 'all time' : `since ${new Date(opts.since).toISOString()}`;
    console.log(`failure composition (${window})`);
    console.log(`  ${result.failures} failed session(s): ${result.process} process (${pct(result.processRate)}), ${result.content} content (${pct(result.contentRate)})`);
    console.log(`  process signals: permission ${result.bySignal.permission}, step-budget ${result.bySignal['step-budget']}, error-loop ${result.bySignal['error-loop']}`);
    console.log(`  ${result.recovered} recovered (succeeded with >=1 error unit; not counted as failures)`);
    if (result.failures === 0) console.log('  ~  no failed sessions in this window');
  }

  if (result.error) return 1;
  return 0;
}

module.exports = {
  PERMISSION_TYPE,
  PERMISSION_RE,
  STEP_BUDGET_RE,
  REPEATED_ERROR_THRESHOLD,
  SIGNAL_ORDER,
  safeJson,
  normalizeToolPart,
  unitsFromSessionMessage,
  unitsFromLegacyPart,
  outcomeFromIdleData,
  sessionSignals,
  classifySession,
  isFailureSession,
  isRecoveredSession,
  analyze,
  readSessions,
  measure,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
