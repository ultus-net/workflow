#!/usr/bin/env node
/**
 * measure-readback-effect.cjs
 *
 * The effect half of the n=12 cap story. n=12 measured retained-preview BYTES
 * (a proxy) and explicitly deferred the real question — when a tool result is
 * truncated into the store, does the model actually need the full text back? —
 * to a fresh-location live A/B. That effect turns out to be recoverable from
 * history already on disk:
 *
 *   - OpenCode v2 records live assistant tool parts in the `session_message`
 *     table (`data` JSON: `.content[].type === "tool"`). The legacy `part`
 *     table holds the same shape for older rows.
 *   - A store SPILL is exactly `metadata.outputPath` on a tool part pointing at
 *     `.../tool-output/tool_*` — the host wrote the full text and handed the
 *     model the bounded preview plus that path.
 *   - A READ-BACK is any later tool part whose `state.input` references such a
 *     path (read/grep/bash/shell/task/... the model re-opened the file).
 *
 * So read-backs per spill is a measured rate over real sessions, not a proxy:
 * a high rate means a tighter cap risks MORE cost (the truncation forces an
 * extra round-trip), which is precisely the failure mode n=12 could not see.
 *
 * Read-only: opens the store `readOnly`, never writes, no config read, no
 * network. Absence of data is a graceful SKIP (exit 0); a *present* store with
 * a schema we cannot read is an error (exit 1), matching verify-effective-model.
 *
 * For a legacy-pinned tier question see verify-effective-model.cjs.
 *
 * Usage:
 *   node install/lib/measure-readback-effect.cjs [--db PATH] [--since ISO]
 *        [--all] [--json] [--bucket-week]
 *
 *   --bucket-week replaces the per-day table with a per-week spill/reopened/rate
 *   series (stability view).
 *
 * Exit codes: 0 = measured or skipped, 1 = error (present-but-unreadable store),
 * 2 = usage error.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const STORE_ID = /tool-output\/(tool_[A-Za-z0-9]+)/;
// Note: a framework-level truncation notice (`Full output saved to: <path>`)
// is a separate mechanism, but it is never counted here because `isSpill`
// keys strictly on `metadata.outputPath`; a framework-notice part has none.

// ─── Pure detection helpers (exported for tests) ─────────────────────────────

/** Parse a JSON string, returning `null` (never throwing) on malformed input. */
function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Extract the store file id from a path, or null if it is not a store path. */
function storeIdOf(p) {
  if (typeof p !== 'string') return null;
  const m = STORE_ID.exec(p);
  return m ? m[1] : null;
}

/** Normalise one tool part (from either message shape) to the fields we use. */
function normalizePart(part) {
  if (!part || part.type !== 'tool') return null;
  const state = part.state || {};
  return {
    tool:     part.name || part.tool || 'unknown',
    callID:   part.callID || part.id || null,
    input:    state.input || {},
    output:   typeof state.output === 'string' ? state.output : '',
    metadata: state.metadata || {},
  };
}

/** Tool parts from a `session_message` row's `data` JSON. */
function partsFromSessionMessage(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  if (!d || !Array.isArray(d.content)) return [];
  return d.content.map(normalizePart).filter(Boolean);
}

/** Tool parts from a legacy `part` row's `data` JSON (the part object itself). */
function partsFromLegacyPart(dataJson) {
  const d = typeof dataJson === 'string' ? safeJson(dataJson) : dataJson;
  const p = normalizePart(d);
  return p ? [p] : [];
}

/** A part is a store spill iff it carries an `outputPath` into the store. */
function isSpill(part) {
  return storeIdOf(part.metadata.outputPath) != null;
}

/** The store file ids referenced by a part's input (read-backs). */
function readbackIds(part) {
  const hay = JSON.stringify(part.input || {});
  const ids = [];
  const re  = new RegExp(STORE_ID.source, 'g');
  let m;
  while ((m = re.exec(hay)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Map store-file id -> `{ session, t, tool }` for every spill-producing part.
 * The producing tool is the spill's own `name`; if an id is ever spilled twice
 * the last writer wins, matching `analyze`'s denominator (distinct ids). Shared
 * with `measure-cap-family.cjs` so both agree on which family produced a file.
 */
function spillProducers(parts) {
  const byId = new Map();
  for (const p of parts) {
    if (!isSpill(p)) continue;
    byId.set(storeIdOf(p.metadata.outputPath), { session: p.session, t: p.t, tool: p.tool });
  }
  return byId;
}

/**
 * Analyse normalised tool parts.
 * Returns per-window totals plus per-day counts. Two distinct ratios, reported
 * separately because they answer different questions:
 *   reopenedRate    = distinct spilled files re-opened / spills  ("how often a
 *                     spill is needed again at all")
 *   refsPerSpill    = read-back references / spills             ("how many
 *                     re-open references per spill"; a call touching N files
 *                     counts N, so this exceeds reopenedRate)
 * plus sameSession variants, distinctFiles, byTool (the read-back tool),
 * bySpillTool (the spill-producing tool: spills/reopened/rate per family, so
 * the aggregate can be sliced by what was truncated), byWeek (the same slice
 * per 7-day bucket, keyed by the SPILL's week, so a rate's stability can be
 * judged before it is acted on), and byDay.
 */
const WEEK_MS = 7 * 864e5;
/** The 7-day bucket a timestamp falls in (UTC, epoch-anchored). */
function weekStartOf(t) {
  return Math.floor(t / WEEK_MS) * WEEK_MS;
}

function analyze(parts) {
  const spillById = new Map(); // id -> {session, t, tool}
  const readbackEvents = [];   // {session, id, t, tool}
  const byDay = new Map();
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const bucket = (t) => {
    const d = day(t);
    if (!byDay.has(d)) byDay.set(d, { tools: 0, spills: 0, readbacks: 0 });
    return byDay.get(d);
  };

  let tools = 0;
  for (const p of parts) {
    tools += 1;
    const b = bucket(p.t);
    b.tools += 1;
    if (isSpill(p)) {
      b.spills += 1;
    }
    const ids = readbackIds(p);
    if (ids.length > 0) {
      b.readbacks += 1;
      for (const id of ids) readbackEvents.push({ session: p.session, id, t: p.t, tool: p.tool });
    }
  }
  for (const [id, known] of spillProducers(parts)) spillById.set(id, known);

  let refsMatched = 0;          // read-back references to a known, earlier spill
  let refsSameSession = 0;      // ... of those, in the spill's own session
  const files = new Set();      // distinct spilled files re-opened at all
  const filesSameSession = new Set();
  const byTool = new Map();
  for (const r of readbackEvents) {
    const known = spillById.get(r.id);
    if (!known) continue;
    if (known.t > r.t) continue; // a read-back cannot precede its spill
    refsMatched += 1;
    files.add(r.id);
    byTool.set(r.tool, (byTool.get(r.tool) || 0) + 1);
    if (known.session === r.session) {
      refsSameSession += 1;
      filesSameSession.add(r.id);
    }
  }

  // Per spill-producing tool, keyed on distinct store ids (same unit as the
  // aggregate `spills` = spillById.size), so denominators never double-count a
  // re-spilled id. If an id is ever spilled twice, the last writer is credited
  // (spillById.set overwrites). `reopened` counts distinct re-opened files,
  // matching `reopenedRate`.
  const spillToolTotals = new Map();
  for (const { tool } of spillById.values()) {
    spillToolTotals.set(tool, (spillToolTotals.get(tool) || 0) + 1);
  }
  const reopenedBySpillTool = new Map();
  for (const id of files) {
    const known = spillById.get(id);
    reopenedBySpillTool.set(known.tool, (reopenedBySpillTool.get(known.tool) || 0) + 1);
  }
  const rateOf = (reopened, spills) => (spills > 0 ? reopened / spills : 0);
  const bySpillTool = Object.fromEntries(
    [...spillToolTotals]
      .map(([tool, spills]) => {
        const reopened = reopenedBySpillTool.get(tool) || 0;
        return [tool, { spills, reopened, rate: rateOf(reopened, spills) }];
      })
      .sort((a, b) => b[1].spills - a[1].spills),
  );

  // Weekly stability series, keyed by the SPILL's week (spillById), so the sum
  // of weekly `spills` equals the aggregate `spills` exactly, and each week's
  // rate answers "of the files spilled that week, how many were re-opened."
  // Each bucket also carries bySpillTool, so a family's rate stability can be
  // judged separately from the volume-weighted aggregate. This is how a rate's
  // noise is judged before it is acted on.
  const weekBuckets = new Map();
  const weekBucket = (w) => {
    if (!weekBuckets.has(w)) weekBuckets.set(w, { spills: 0, reopened: 0, bySpillTool: new Map() });
    return weekBuckets.get(w);
  };
  const weekToolBucket = (w, tool) => {
    const b = weekBucket(w);
    if (!b.bySpillTool.has(tool)) b.bySpillTool.set(tool, { spills: 0, reopened: 0 });
    return b.bySpillTool.get(tool);
  };
  for (const { t, tool } of spillById.values()) {
    const w = weekStartOf(t);
    weekBucket(w).spills += 1;
    weekToolBucket(w, tool).spills += 1;
  }
  for (const id of files) {
    const known = spillById.get(id);
    const w = weekStartOf(known.t);
    weekBucket(w).reopened += 1;
    weekToolBucket(w, known.tool).reopened += 1;
  }
  const byWeek = Object.fromEntries(
    [...weekBuckets]
      .sort((a, b) => a[0] - b[0])
      .map(([w, v]) => [new Date(w).toISOString().slice(0, 10), {
        spills: v.spills,
        reopened: v.reopened,
        rate: rateOf(v.reopened, v.spills),
        bySpillTool: Object.fromEntries(
          [...v.bySpillTool]
            .map(([tool, s]) => [tool, { spills: s.spills, reopened: s.reopened, rate: rateOf(s.reopened, s.spills) }])
            .sort((a, b) => b[1].spills - a[1].spills),
        ),
      }]),
  );

  const spills = spillById.size;
  const fractionOf = (n) => (spills > 0 ? n / spills : 0);
  return {
    tools,
    spills,
    readbacks: readbackEvents.length,
    refsMatched,
    refsSameSession,
    distinctFiles: files.size,
    distinctSameSession: filesSameSession.size,
    // Headline: fraction of spills at least one of whose files was re-opened.
    reopenedRate:       fractionOf(files.size),
    sameSessionRate:    fractionOf(filesSameSession.size),
    // Intensity: re-open references per spill (a call touching N files counts N).
    refsPerSpill:       fractionOf(refsMatched),
    sameSessionRefsPerSpill: fractionOf(refsSameSession),
    byTool:             Object.fromEntries([...byTool].sort((a, b) => b[1] - a[1])),
    bySpillTool,
    byWeek,
    byDay:              Object.fromEntries([...byDay].sort()),
  };
}

// ─── Store access (read-only, skip-vs-error semantics) ───────────────────────

/**
 * Read tool parts from the store. Prefers the v2 `session_message` table and
 * falls back to the legacy `part` table. Returns `{ parts, skipped, error }`
 * with verify-effective-model's contract: absent store/table -> skipped;
 * present but unreadable -> error.
 */
function readToolParts(dbPath, since) {
  if (!fs.existsSync(dbPath)) return { parts: [], skipped: `no store at ${dbPath}`, error: null };
  let sqlite;
  try { sqlite = require('node:sqlite'); }
  catch { return { parts: [], skipped: 'node:sqlite unavailable in this runtime', error: null }; }

  let db;
  try { db = new sqlite.DatabaseSync(dbPath, { readOnly: true }); }
  catch (err) { return { parts: [], skipped: null, error: `cannot open store: ${err.message}` }; }

  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    const v2 = tables.has('session_message');
    const legacy = tables.has('part');
    if (!v2 && !legacy) return { parts: [], skipped: 'no session_message or part table', error: null };

    const parts = [];
    // A malformed row is format drift, not absence. Any unparseable row fails
    // loud: partially-malformed windows would silently under-count spills and
    // read-backs, so we refuse to report a rate we cannot trust.
    const unparseable = [];
    if (v2) {
      const where  = ["type = 'assistant'", 'data IS NOT NULL'];
      const params = [];
      if (since != null) { where.push('time_created > ?'); params.push(since); }
      const rows = db
        .prepare(`SELECT session_id, data, time_created FROM session_message WHERE ${where.join(' AND ')}`)
        .all(...params);
      for (const r of rows) {
        const d = safeJson(r.data);
        if (d == null) { unparseable.push(r.session_id); continue; }
        for (const p of partsFromSessionMessage(d)) parts.push({ ...p, session: r.session_id, t: r.time_created });
      }
    } else {
      const where  = ['data IS NOT NULL'];
      const params = [];
      if (since != null) { where.push('time_created > ?'); params.push(since); }
      const rows = db
        .prepare(`SELECT session_id, data, time_created FROM part WHERE ${where.join(' AND ')}`)
        .all(...params);
      for (const r of rows) {
        if (safeJson(r.data) == null) { unparseable.push(r.session_id); continue; }
        for (const p of partsFromLegacyPart(r.data)) parts.push({ ...p, session: r.session_id, t: r.time_created });
      }
    }
    if (unparseable.length > 0) {
      return { parts: [], skipped: null, error: `${unparseable.length} store row(s) unparseable (format drift)` };
    }
    return { parts, skipped: null, error: null };
  } catch (err) {
    return { parts: [], skipped: null, error: `query failed: ${err.message}` };
  } finally {
    db.close();
  }
}

/** Full measurement used by the CLI: read + analyze, preserving skip/error. */
function measure(options = {}) {
  const { parts, skipped, error } = readToolParts(options.dbPath, options.since);
  if (error) return { skipped: null, error };
  if (skipped) return { skipped, error: null };
  return { skipped: null, error: null, ...analyze(parts) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 30;

function parseArgs(argv) {
  const opts = {
    dbPath: path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    since:  null,
    all:    false,
    json:   false,
    bucketWeek: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db')         { const v = argv[++i]; if (v == null) return { error: '--db requires a path' }; opts.dbPath = v; }
    else if (a === '--since') { const v = argv[++i]; if (v == null) return { error: '--since requires an ISO timestamp' }; opts.since = Date.parse(v); }
    else if (a === '--all')   opts.all = true;
    else if (a === '--json')  opts.json = true;
    else if (a === '--bucket-week') opts.bucketWeek = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (opts.since != null && Number.isNaN(opts.since)) return { error: 'invalid --since timestamp' };
  if (opts.all) opts.since = null; // --all means all time; it overrides --since
  else if (opts.since == null) opts.since = Date.now() - DEFAULT_WINDOW_DAYS * 864e5;
  return opts;
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: measure-readback-effect.cjs [--db PATH] [--since ISO] [--all] [--json] [--bucket-week]');
    return 0;
  }

  const result = measure(opts);

  if (opts.json) {
    console.log(JSON.stringify({ since: opts.since == null ? null : new Date(opts.since).toISOString(), ...result }, null, 2));
  } else if (result.error) {
    console.error(`  \u2717  read-back effect check failed \u2014 ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  read-back effect check skipped \u2014 ${result.skipped}`);
  } else {
    const window = opts.since == null ? 'all time' : `since ${new Date(opts.since).toISOString()}`;
    console.log(`tool-output read-back effect (${window})`);
    console.log(`  ${result.tools} tool calls; ${result.spills} store spills; ${result.readbacks} read-back refs`);
    console.log(`  spills re-opened at all: ${result.distinctFiles} (${pct(result.reopenedRate)} of spills); same-session ${result.distinctSameSession} (${pct(result.sameSessionRate)})`);
    console.log(`  re-open references: ${result.refsMatched} (${result.refsPerSpill.toFixed(2)} per spill; same-session ${result.sameSessionRefsPerSpill.toFixed(2)})`);
    const tools = Object.entries(result.byTool).map(([t, n]) => `${t}\u00d7${n}`).join(', ');
    if (tools) console.log(`  read-back tool mix: ${tools}`);
    const spillRows = Object.entries(result.bySpillTool);
    if (spillRows.length > 1) {
      console.log('  spilled by            spills  reopened   rate');
      for (const [t, b] of spillRows) {
        console.log(`  ${t.padEnd(20)}  ${String(b.spills).padStart(6)}  ${String(b.reopened).padStart(8)}  ${pct(b.rate).padStart(6)}`);
      }
    }
    const days = Object.values(result.byDay);
    if (opts.bucketWeek) {
      const weeks = Object.entries(result.byWeek);
      if (weeks.length > 1) {
        console.log('  week        tool                  spills  reopened   rate');
        for (const [w, b] of weeks) {
          console.log(`  ${w}  ${'(all)'.padEnd(20)}  ${String(b.spills).padStart(6)}  ${String(b.reopened).padStart(8)}  ${pct(b.rate).padStart(6)}`);
          for (const [t, s] of Object.entries(b.bySpillTool)) {
            if (s.spills < 2) continue; // tiny-n families are not decision-grade
            console.log(`  ${''.padEnd(10)}  ${t.padEnd(20)}  ${String(s.spills).padStart(6)}  ${String(s.reopened).padStart(8)}  ${pct(s.rate).padStart(6)}`);
          }
        }
      }
    } else if (days.length > 1) {
      console.log('  day        tools  spills  readbacks');
      for (const [d, b] of Object.entries(result.byDay)) {
        console.log(`  ${d}  ${String(b.tools).padStart(5)}  ${String(b.spills).padStart(6)}  ${String(b.readbacks).padStart(9)}`);
      }
    }
    if (result.spills === 0) console.log('  ~  no store spills in this window');
  }

  if (result.error) return 1;
  return 0;
}

module.exports = {
  STORE_ID,
  WEEK_MS,
  weekStartOf,
  safeJson,
  storeIdOf,
  normalizePart,
  partsFromSessionMessage,
  partsFromLegacyPart,
  isSpill,
  readbackIds,
  spillProducers,
  analyze,
  readToolParts,
  measure,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
