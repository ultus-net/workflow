#!/usr/bin/env node
/**
 * measure-cap-family.cjs
 *
 * The byte side of the cap decision, sliced the way the rate side already is.
 * n=12 (`measure-tool-output.cjs`) projects retained preview bytes over the
 * whole store, but the store is heterogeneous: n=14/n=15
 * (`measure-readback-effect.cjs`) showed the spill families differ by an order
 * of magnitude in read-back rate, so an aggregate byte delta hides *which*
 * family a tighter cap squeezes. The producing tool of each store file is
 * recoverable — a spill part's `metadata.outputPath` is the store path, and the
 * file id is its basename — so this ruler joins the two existing rulers and
 * reports, per producing family and per candidate cap:
 *
 *   files, full bytes, retained bytes, removed bytes, and the family's
 *   measured re-open rate at the current cap.
 *
 * It is a pure measurement of the store already on disk. It does NOT multiply
 * bytes by a rate, invent a byte<->cost currency, or recommend a cap; the byte
 * delta (deterministic given the store) and the rate (measured at the current
 * cap) are two axes shown side by side. A tighter cap changes the spill set, so
 * the rate column is context, not a projection.
 *
 * Read-only. Absence of the store DB is a graceful SKIP (exit 0); a present DB
 * with unparseable rows is an error (exit 1), matching measure-readback-effect.
 * Files the DB cannot resolve to a producer are kept in an explicit
 * `(unknown)` row, so the per-family sums always reconcile to the aggregate
 * `measure-tool-output` projection (asserted in the fixtures).
 *
 * Usage:
 *   node install/lib/measure-cap-family.cjs [--store DIR] [--db PATH]
 *        [--settings MAX_LINES/MAX_BYTES]... [--json]
 */

'use strict';

const os   = require('os');
const path = require('path');

const bytes  = require('./measure-tool-output.cjs');
const effect = require('./measure-readback-effect.cjs');

const UNKNOWN = '(unknown)';

/**
 * Attribute one cap over a scan. `producers` maps store id -> { tool }, from
 * `effect.spillProducers`; `rates` maps producing tool -> { reopened, rate }
 * from `effect.analyze(...).bySpillTool` (measured at the current cap and over
 * the same window). Returns per-family rows plus totals; the `(unknown)` row
 * keeps unresolved files in the sums so nothing is silently dropped.
 */
function attribute(scan, producers, rates, maxLines, maxBytes, marker) {
  const fam = new Map();
  const row = (tool) => {
    if (!fam.has(tool)) fam.set(tool, { files: 0, fullBytes: 0, retainedBytes: 0, removedBytes: 0, inlined: 0, spilled: 0 });
    return fam.get(tool);
  };
  let totalFull = 0;
  let totalRetained = 0;
  let unresolved = 0;
  for (const f of scan.files) {
    const id = f.name;
    const p = producers.get(id);
    const tool = p ? p.tool : UNKNOWN;
    if (!p) unresolved += 1;
    const r = row(tool);
    const retained = bytes.retainedBytes(f, maxLines, maxBytes, marker);
    r.files += 1;
    r.fullBytes += f.bytes;
    r.retainedBytes += retained;
    r.removedBytes += f.bytes - retained;
    if (f.lines <= maxLines && f.bytes <= maxBytes) r.inlined += 1;
    else r.spilled += 1;
    totalFull += f.bytes;
    totalRetained += retained;
  }
  const families = Object.fromEntries(
    [...fam]
      .map(([tool, r]) => {
        const rate = rates[tool] || null;
        return [tool, { ...r, reopened: rate ? rate.reopened : null, rate: rate ? rate.rate : null }];
      })
      .sort((a, b) => b[1].fullBytes - a[1].fullBytes),
  );
  // Reconcile against the n=12 aggregate projection over the same scan.
  const aggregate = bytes.project(scan, maxLines, maxBytes, marker);
  return {
    maxLines,
    maxBytes,
    families,
    totals: { files: scan.files.length, fullBytes: totalFull, retainedBytes: totalRetained, removedBytes: totalFull - totalRetained },
    unresolved,
    aggregateRetainedBytes: aggregate.retainedBytes,
    reconciles: totalRetained === aggregate.retainedBytes,
  };
}

/** Build the per-cap attribution for an ordered settings list. */
function projectFamilies(scan, producers, rates, settings, marker) {
  return settings.map((s) => ({ label: s.label, ...attribute(scan, producers, rates, s.maxLines, s.maxBytes, marker) }));
}

/** Default/current settings, de-duplicated; delegates to the n=12 ruler so the
 *  two cannot drift. */
function defaultSettings(explicit = []) {
  return bytes.settingsFor({ settings: explicit });
}

/** Read + join, preserving the read-back ruler's skip/error contract. */
function measure(options = {}) {
  const store = options.store || path.join(os.homedir(), '.local/share/opencode/tool-output');
  const dbPath = options.dbPath || path.join(os.homedir(), '.local/share/opencode/opencode.db');
  const scan = bytes.scanStore(store);
  if (scan.error) return { error: scan.error, skipped: null };
  const { parts, skipped, error } = effect.readToolParts(dbPath, options.since == null ? null : options.since);
  if (error) return { error, skipped: null };
  if (skipped) return { error: null, skipped, scan };
  const producers = effect.spillProducers(parts);
  const rates = effect.analyze(parts).bySpillTool;
  const settings = defaultSettings(options.settings || []);
  const marker = bytes.markerFor(store);
  return { error: null, skipped: null, producers: producers.size, projections: projectFamilies(scan, producers, rates, settings, marker) };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 30;

function parseArgs(argv) {
  const opts = {
    store: path.join(os.homedir(), '.local', 'share', 'opencode', 'tool-output'),
    dbPath: path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    settings: [],
    since: null,
    all: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') { const v = argv[++i]; if (v == null) return { error: '--store requires a directory' }; opts.store = path.resolve(v); }
    else if (a === '--db') { const v = argv[++i]; if (v == null) return { error: '--db requires a path' }; opts.dbPath = v; }
    else if (a === '--since') { const v = argv[++i]; if (v == null) return { error: '--since requires an ISO timestamp' }; opts.since = Date.parse(v); opts.all = false; }
    else if (a === '--all') { opts.all = true; opts.since = null; }
    else if (a === '--settings') {
      const v = argv[++i];
      if (v == null) return { error: '--settings requires MAX_LINES/MAX_BYTES' };
      const m = /^(\d+)\/(\d+)$/.exec(v);
      if (!m) return { error: `invalid --settings (want maxLines/maxBytes): ${v}` };
      opts.settings.push({ maxLines: Number(m[1]), maxBytes: Number(m[2]) });
    } else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (opts.since != null && Number.isNaN(opts.since)) return { error: 'invalid --since timestamp' };
  if (!opts.all && opts.since == null) opts.since = Date.now() - DEFAULT_WINDOW_DAYS * 864e5;
  return opts;
}

function kib(n) { return (n / 1024).toFixed(1); }

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: measure-cap-family.cjs [--store DIR] [--db PATH] [--settings MAX_LINES/MAX_BYTES]... [--json]');
    return 0;
  }
  const result = measure(opts);
  if (opts.json) {
    console.log(JSON.stringify({ store: opts.store, db: opts.dbPath, ...result }, null, 2));
  } else if (result.error) {
    console.error(`  \u2717  per-family cap check failed \u2014 ${result.error}`);
  } else if (result.skipped) {
    console.log(`  ~  per-family cap check skipped \u2014 ${result.skipped}`);
  } else {
    console.log('per-family retained preview bytes by producing tool');
    console.log(`  ${result.producers} store id(s) resolved to a producer in the window`);
    for (const p of result.projections) {
      console.log(`  cap ${p.label}: ${p.maxLines} lines / ${p.maxBytes} B \u2014 ${p.totals.files} files, retained ${kib(p.totals.retainedBytes)} KiB, removed ${kib(p.totals.removedBytes)} KiB`);
      console.log('    family                files   full KiB   retained   removed   spilled   reopened     rate');
      for (const [t, r] of Object.entries(p.families)) {
        const rate = r.rate == null ? '     n/a' : (r.rate * 100).toFixed(1).padStart(7) + '%';
        const reopened = r.reopened == null ? 'n/a' : String(r.reopened);
        console.log(`    ${t.padEnd(20)}  ${String(r.files).padStart(5)}  ${kib(r.fullBytes).padStart(9)}  ${kib(r.retainedBytes).padStart(9)}  ${kib(r.removedBytes).padStart(8)}  ${String(r.spilled).padStart(7)}  ${reopened.padStart(8)}  ${rate.padStart(8)}`);
      }
      console.log(`    ${'(reconcile)'.padEnd(20)}  aggregate retained ${kib(p.aggregateRetainedBytes)} KiB; matches: ${p.reconciles}${p.unresolved ? `; unresolved files: ${p.unresolved}` : ''}`);
      console.log('    (reopened/rate are measured at the *current* cap over the same window; a tighter cap changes the spill set, so they are context, not a projection)');
    }
  }
  if (result.error) return 1;
  return 0;
}

module.exports = {
  UNKNOWN,
  attribute,
  projectFamilies,
  defaultSettings,
  measure,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
