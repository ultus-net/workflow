#!/usr/bin/env node
/**
 * measure-permission-friction.cjs
 *
 * A read-only instrument for the permission-denial population. The ledger
 * routed on a denial figure for two iterations ("the reviewer-agent
 * external_directory blindness: 749 denials, 24 days, 269 blind sessions" —
 * docs/agents/ledger.md:888, :908) that no file under install/lib produced.
 * This is the ruler that replaces that prose with a reproducible number, the
 * same inertia-clearing instrument shape as n=12 (retained tool-output bytes),
 * n=13 (read-back effect), n=16 (failure composition), and n=35 (compaction).
 *
 * A denial is structural, not textual. OpenCode v2 stores each assistant turn
 * as a `session_message` row whose `data.content[]` holds tool items; a denied
 * call carries `state.status === 'error'` with
 * `state.error.type === 'permission.rejected'` and a human message of the form
 * `Permission denied: <class>`. Keying on the error TYPE (not the message text)
 * is what keeps this a census of denials rather than of any error that happens
 * to mention permission.
 *
 * MISLABELING WARNING (the reason the instrument names its unit): a "denial" is
 * a tool CALL that was refused, not a session. One agent turn can issue several
 * denied calls, so `denials` (units) is always ≥ `sessions` (the distinct
 * sessions that carried at least one denial). The two are reported separately,
 * and `byAgent` counts UNITS; a reader must not read the by-agent split as a
 * session count.
 *
 * Read-only: opens the store `readOnly`, never writes, no config read, no
 * network. Absence of data is a graceful SKIP (exit 0); a present store with a
 * schema we cannot read is an error (exit 1), matching the sibling rulers.
 *
 * This is an instrument, not a decision: it reports what the read plane denied,
 * so a later, measured iteration can decide whether to widen a grant. It never
 * grants, scores, or writes.
 *
 * Usage:
 *   node install/lib/measure-permission-friction.cjs [--db PATH] [--since ISO]
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

/** The message prefix a denied call carries, e.g. "Permission denied: shell". */
const DENIED_PREFIX = /^Permission denied:\s*/;

/**
 * The denial class from an error message: the token after "Permission denied: ".
 * Falls back to "(unnamed)" so an empty message is still counted (fail-visible),
 * never silently dropped.
 */
function denialClass(message) {
  if (typeof message !== 'string') return '(unnamed)';
  const m = message.replace(DENIED_PREFIX, '').trim();
  return m === '' ? '(unnamed)' : m;
}

/**
 * The top-level root of a denied input path, aggregated so a census never
 * commits a machine-specific absolute path. The first three segments below the
 * leading slash (`/tmp/x/y` -> `/tmp/x/y`, `/a/b/c/d` -> `/a/b/c`), or the whole
 * string when shorter. A non-string yields null (the row has no path input).
 */
function pathRoot(p) {
  if (typeof p !== 'string' || p === '') return null;
  const parts = p.split('/').filter((s) => s !== '');
  if (parts.length === 0) return '/';
  return parts.slice(0, 3).map((s) => '/' + s).join('').replace(/\/+$/, '');
}

/**
 * The input-derived location of a denied call as `{ value, kind }`, or null.
 * Tools differ: `read`/`glob`/`grep` carry a filesystem `path`; `shell` carries
 * a `command` (NOT a path). Only a filesystem path yields a `pathRoot`; a
 * `command` is reported as its own kind so a shell command never pollutes the
 * path-root histogram with a pseudo-path (e.g. "/ls -la /var/home").
 */
function denialTarget(input) {
  if (!input || typeof input !== 'object') return null;
  for (const k of ['path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string' && v !== '') return { value: v, kind: 'path' };
  }
  for (const k of ['pattern', 'command']) {
    const v = input[k];
    if (typeof v === 'string' && v !== '') return { value: v, kind: k === 'command' ? 'command' : 'pattern' };
  }
  return null;
}

/**
 * Map one tool item to a denial, or null when it is not a permission denial.
 * The single structural predicate the whole census rests on: a denial is a tool
 * item with `state.status === 'error'` and `state.error.type ===
 * 'permission.rejected'`, never a message-text match.
 */
function denialFromItem(it, agent, t) {
  const st = it.state || {};
  const err = st.error || {};
  if (st.status !== 'error' || err.type !== 'permission.rejected') return null;
  const target = denialTarget(st.input);
  return {
    tool:       typeof it.name === 'string' ? it.name : (typeof it.tool === 'string' ? it.tool : 'unknown'),
    cls:        denialClass(err.message),
    target:     target ? target.value : null,
    targetKind: target ? target.kind : 'none',
    root:       target && target.kind === 'path' ? pathRoot(target.value) : null,
    agent:      typeof agent === 'string' ? agent : 'unknown',
    t:          typeof t === 'number' ? t : null,
  };
}

/**
 * Normalise one `session_message` row to the denials it carries: the row's data
 * JSON is `{ content: [ {type:'tool', ...}, ... ] }`. Returns [] when the row
 * has no denied tool item. A non-object data JSON yields null so the caller can
 * fail loud.
 */
function denialsFromRow(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = [];
  const content = Array.isArray(d.content) ? d.content : [];
  const t = (d.time && typeof d.time.created === 'number') ? d.time.created : null;
  for (const it of content) {
    if (!it || typeof it !== 'object' || it.type !== 'tool') continue;
    const denial = denialFromItem(it, d.agent, t);
    if (denial) out.push(denial);
  }
  return out;
}

/**
 * Normalise one legacy `part` row to the denials it carries: the row's data JSON
 * IS the tool part object (`{type:'tool', name, state, ...}`), not a
 * `{content: [...]}` wrapper. This is why the two readers are separate — reusing
 * the v2 reader here would silently return zero denials on a legacy-only store.
 * Returns [] when the part is not a denied tool call; null on a malformed row.
 * The agent is not on a legacy part, so the caller fills it from the session
 * join.
 */
function denialsFromLegacyPart(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.type !== 'tool') return [];
  const t = (d.time && typeof d.time.created === 'number') ? d.time.created : null;
  const denial = denialFromItem(d, d.agent, t);
  return denial ? [denial] : [];
}

/** Increment `m[key]` in a plain-object counter. Pure-ish (mutates `m`). */
function bump(m, key) { m[key] = (m[key] || 0) + 1; }

/**
 * Summarise a flat list of normalised denials. Returns the unit and session
 * counts, the class/tool/agent/path-root/target-kind splits, and the window
 * span. Denials arrive already carrying `agent` and `session` (joined by the
 * reader).
 */
function summarize(denials) {
  const byClass = {};
  const byTool = {};
  const byAgent = {};
  const byRoot = {};
  const byTargetKind = {};
  const perSession = new Map();
  let minT = null;
  let maxT = null;

  for (const d of denials) {
    bump(byClass, d.cls);
    bump(byTool, d.tool);
    bump(byAgent, d.agent || 'unknown');
    bump(byTargetKind, d.targetKind || 'none');
    if (d.root) bump(byRoot, d.root);
    const sid = d.session || '(none)';
    perSession.set(sid, (perSession.get(sid) || 0) + 1);
    if (typeof d.t === 'number') {
      if (minT === null || d.t < minT) minT = d.t;
      if (maxT === null || d.t > maxT) maxT = d.t;
    }
  }

  return {
    denials:      denials.length,
    sessions:     perSession.size,
    byClass,
    byTool,
    byAgent,
    byRoot,
    byTargetKind,
    earliest:     minT === null ? null : minT,
    latest:       maxT === null ? null : maxT,
    spanDays:     (minT === null || maxT === null) ? null : (maxT - minT) / 864e5,
  };
}

// ─── Store access (read-only, skip-vs-error semantics) ───────────────────────

/**
 * Read denial units from the store. Denials live in `session_message` (v2) as a
 * `content[]` array; the legacy `part` table stores the SAME tool object one row
 * per part (`data` IS the part), so it is read with its own parser. Reusing the
 * v2 `content[]` reader for a legacy part would silently return zero denials, so
 * the two readers stay separate. Agent is carried on the row's own data JSON
 * (the `agent` field the host writes per assistant turn), with a `session_v2`
 * join as a fallback when the row omits it. Returns `{ denials, skipped, error }`
 * with the sibling rulers' contract: absent store/table -> skipped; present but
 * unreadable -> error; any unparseable row -> error (a malformed row must fail
 * loud, not silently under-count).
 */
function readDenials(dbPath, since) {
  if (!fs.existsSync(dbPath)) return { denials: [], skipped: `no store at ${dbPath}`, error: null };
  let sqlite;
  try { sqlite = require('node:sqlite'); }
  catch { return { denials: [], skipped: 'node:sqlite unavailable in this runtime', error: null }; }

  let db;
  try { db = new sqlite.DatabaseSync(dbPath, { readOnly: true }); }
  catch (err) { return { denials: [], skipped: null, error: `cannot open store: ${err.message}` }; }

  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    const v2 = tables.has('session_message');
    const legacy = tables.has('part');
    if (!v2 && !legacy) return { denials: [], skipped: 'no session_message or part table', error: null };

    // Agent fallback by session, from whichever session table exists. A schema
    // mismatch degrades gracefully (agent unknown), never an error: the denial
    // evidence is in the message store regardless.
    const agentBySession = new Map();
    const sessionTable = tables.has('session_v2') ? 'session_v2' : (tables.has('session') ? 'session' : null);
    if (sessionTable) {
      try {
        for (const r of db.prepare(`SELECT id, agent FROM ${sessionTable}`).all()) {
          if (r.agent) agentBySession.set(r.id, r.agent);
        }
      } catch { /* session table shape drift: the row's own agent field still applies */ }
    }

    const denials = [];
    const unparseable = [];

    // `parse` is the row reader (v2 `content[]` vs legacy single part); `rowT`
    // is the row's own `time_created`, so the reported span comes from the SAME
    // column the `--since` filter uses (never the JSON's `time.created`, which
    // could disagree).
    const collect = (rows, parse) => {
      for (const r of rows) {
        const parsed = parse(r.data);
        if (parsed == null) { unparseable.push(r.session_id); continue; }
        for (const u of parsed) {
          if (u.agent === 'unknown' && agentBySession.has(r.session_id)) u.agent = agentBySession.get(r.session_id);
          denials.push({ ...u, t: typeof r.time_created === 'number' ? r.time_created : u.t, session: r.session_id });
        }
      }
    };

    if (v2) {
      const where  = ['data IS NOT NULL', "data LIKE '%permission.rejected%'"];
      const params = [];
      if (since != null) { where.push('time_created > ?'); params.push(since); }
      collect(db
        .prepare(`SELECT session_id, data, time_created FROM session_message WHERE ${where.join(' AND ')}`)
        .all(...params), denialsFromRow);
    } else {
      const where  = ['data IS NOT NULL', "data LIKE '%permission.rejected%'"];
      const params = [];
      if (since != null) { where.push('time_created > ?'); params.push(since); }
      collect(db
        .prepare(`SELECT session_id, data, time_created FROM part WHERE ${where.join(' AND ')}`)
        .all(...params), denialsFromLegacyPart);
    }

    if (unparseable.length > 0) {
      return { denials: [], skipped: null, error: `${unparseable.length} store row(s) unparseable (format drift)` };
    }
    return { denials, skipped: null, error: null };
  } catch (err) {
    return { denials: [], skipped: null, error: `query failed: ${err.message}` };
  } finally {
    db.close();
  }
}

/** Full measurement used by the CLI: read + summarize, preserving skip/error. */
function measure(options = {}) {
  const { denials, skipped, error } = readDenials(options.dbPath, options.since);
  if (error) return { skipped: null, error };
  if (skipped) return { skipped, error: null };
  return { skipped: null, error: null, ...summarize(denials) };
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

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: measure-permission-friction.cjs [--db PATH] [--since ISO] [--all] [--json]');
    return 0;
  }

  const result = measure(opts);

  if (opts.json) {
    console.log(JSON.stringify({ since: opts.since == null ? null : new Date(opts.since).toISOString(), ...result }, null, 2));
  } else if (result.error) {
    console.error(`  \u2717  permission-friction ruler failed \u2014 ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  permission-friction ruler skipped \u2014 ${result.skipped}`);
  } else {
    const window = opts.since == null ? 'all time' : `since ${new Date(opts.since).toISOString()}`;
    console.log(`permission friction (${window})`);
    console.log(`  ${result.denials} denied call(s) over ${result.sessions} session(s)`);
    const classes = Object.entries(result.byClass).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  by class: ${classes || '(none)'}`);
    const tools = Object.entries(result.byTool).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  by tool: ${tools || '(none)'}`);
    const agents = Object.entries(result.byAgent).map(([k, n]) => `${k}\u00d7${n}`).join(', ');
    console.log(`  by agent (units): ${agents || '(none)'}`);
    const kinds = Object.entries(result.byTargetKind).map(([k, n]) => `${k} ${n}`).join(', ');
    console.log(`  by target kind: ${kinds || '(none)'}`);
    const roots = Object.entries(result.byRoot).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
    if (roots) console.log(`  top path roots: ${roots}`);
    if (result.earliest != null) {
      console.log(`  span: ${new Date(result.earliest).toISOString()} .. ${new Date(result.latest).toISOString()} (${result.spanDays.toFixed(1)} days)`);
    }
    if (result.denials === 0) console.log('  ~  no denied calls in this window');
  }

  if (result.error) return 1;
  return 0;
}

module.exports = {
  safeJson,
  denialClass,
  pathRoot,
  denialTarget,
  denialFromItem,
  denialsFromRow,
  denialsFromLegacyPart,
  summarize,
  readDenials,
  measure,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
