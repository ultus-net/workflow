#!/usr/bin/env node
/**
 * measure-tool-output.cjs
 *
 * A read-only ruler over the tool-output store: given the store of full
 * pre-cap outputs, project how many bytes of *retained preview* the model
 * would see at a given `tool_output` cap. This is the instrument the n=8/n=9
 * cap changes lacked -- those values were picked by inspecting the store, not
 * by a reproducible projection.
 *
 * The preview math is a faithful port of the pinned host
 * (`opencode-src` rev 3dd1b305, packages/core/src/tool-output-store.ts):
 *   limits()  -> { max_lines ?? 2000, max_bytes ?? 51200 }
 *   bound()   -> within BOTH limits: returned unchanged (no spill, no store file)
 *                otherwise: full text to disk, preview bounded to the limits
 *   preview() -> line-sample head/tail halves, then byte-split head/tail halves
 *                against (maxLines-4, maxBytes-markerBytes-4)
 *
 * It never writes: no files touched, no config read, no network. Projections
 * are pure functions of `{bytes, lines}` per file plus the marker length.
 *
 * Honesty caveat (load-bearing): retained-preview bytes is a *proxy* for
 * context cost, not a measured effect. n=8 established that a converged cap is
 * not the same as a measured effect; a tighter cap can lower read-back rates.
 * Use this ruler to bound and compare settings, not to claim an outcome.
 *
 * Exit codes: 0 = projected, 1 = error (unreadable store), 2 = usage error.
 *
 * Usage:
 *   node install/lib/measure-tool-output.cjs [--store DIR] [--json]
 *        [--settings "MAX_LINES/MAX_BYTES"]...
 *
 * Defaults to the live store and prints the host default (2000/51200), the
 * current overlay value (from install/opencode/config.jsonc; parity-pinned in
 * the fixture), and any explicit --settings.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Host constants (tool-output-store.ts:15-16).
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024; // 51200
// Current overlay value (install/opencode/config.jsonc), shown for comparison.
const CURRENT_MAX_LINES = 800;
const CURRENT_MAX_BYTES = 30000;
// `Identifier.ascending()` yields `tool_` + 26 chars; used only for marker length.
const MARKER_ID = 'x'.repeat(26);

// ─── Host-faithful preview math (pure) ───────────────────────────────────────

/** Take a UTF-8-safe prefix of at most `maximumBytes` bytes. */
function takePrefix(input, maximumBytes) {
  let bytes = 0;
  let content = '';
  for (const char of input) {
    const size = Buffer.byteLength(char, 'utf-8');
    if (bytes + size > maximumBytes) break;
    content += char;
    bytes += size;
  }
  return content;
}

/** Take a UTF-8-safe suffix of at most `maximumBytes` bytes. */
function takeSuffix(input, maximumBytes) {
  let bytes = 0;
  const content = [];
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, 'utf-8');
    if (bytes + size > maximumBytes) break;
    content.unshift(char);
    bytes += size;
  }
  return content.join('');
}

/** Port of host `preview(text, maxLines, maxBytes)`; returns `{ head, tail }`. */
function preview(text, maxLines, maxBytes) {
  const lines = text.split('\n');
  const headLines = Math.ceil(maxLines / 2);
  const tailLines = Math.floor(maxLines / 2);
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join('\n'),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join('\n')] : []),
        ].join('\n');
  if (Buffer.byteLength(sampled, 'utf-8') <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: '' }
      : {
          head: lines.slice(0, headLines).join('\n'),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join('\n') : '',
        };
  }
  const headBytes = Math.ceil(maxBytes / 2);
  const tailBytes = Math.floor(maxBytes / 2);
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) };
}

/** Port of host `boundedPreview`: bounded preview plus the truncation marker. */
function boundedPreview(text, marker, maxLines, maxBytes) {
  const markerOnly = takePrefix(marker, maxBytes).split('\n').slice(0, maxLines).join('\n');
  const markerBytes = Buffer.byteLength(marker, 'utf-8');
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly;
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4);
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`;
}

/** The marker the host writes; only its byte length matters to the ruler. */
function markerFor(storeDir) {
  return `... output truncated; full content saved to ${path.join(storeDir, `tool_${MARKER_ID}`)} ...`;
}

// ─── Store scan + projection ─────────────────────────────────────────────────

/**
 * Read every `tool_*` file's size and line count. The store holds the full
 * pre-cap text, so a file present here is a spill under some cap.
 */
function scanStore(storeDir) {
  const files = [];
  let readErrors = 0;
  let names;
  try {
    names = fs.readdirSync(storeDir);
  } catch {
    return { error: `store not readable: ${storeDir}`, files: [], readErrors: 0 };
  }
  for (const name of names) {
    if (!name.startsWith('tool_')) continue;
    const full = path.join(storeDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const text = fs.readFileSync(full, 'utf8');
      // Host lineCount counts '\n' + 1, so even '' is 1 line; match it.
      const lines = text.split('\n').length;
      files.push({ name, bytes: stat.size, lines, mtime: stat.mtime.toISOString(), text });
    } catch {
      readErrors += 1;
    }
  }
  return { files, readErrors };
}

/** Retained bytes for one file at a cap: unchanged if within both limits, else bounded. */
function retainedBytes(file, maxLines, maxBytes, marker) {
  if (file.lines <= maxLines && file.bytes <= maxBytes) return file.bytes;
  return Buffer.byteLength(boundedPreview(file.text, marker, maxLines, maxBytes), 'utf-8');
}

/** Project retained preview across the scanned files for one cap. */
function project(scan, maxLines, maxBytes, marker) {
  let retained = 0;
  let unchanged = 0;
  let bounded = 0;
  let inlined = 0;
  let spilled = 0;
  for (const f of scan.files) {
    const r = retainedBytes(f, maxLines, maxBytes, marker);
    retained += r;
    if (f.lines <= maxLines && f.bytes <= maxBytes) {
      unchanged += r;
      inlined += 1;
    } else {
      bounded += r;
      spilled += 1;
    }
  }
  return { maxLines, maxBytes, files: scan.files.length, inlined, spilled, retainedBytes: retained, unchangedBytes: unchanged, boundedBytes: bounded };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { store: path.join(os.homedir(), '.local/share/opencode/tool-output'), settings: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') {
      const v = argv[++i];
      if (v == null) return { error: '--store requires a directory' };
      opts.store = path.resolve(v);
    } else if (a === '--settings') {
      const v = argv[++i];
      if (v == null) return { error: '--settings requires MAX_LINES/MAX_BYTES' };
      const m = /^(\d+)\/(\d+)$/.exec(v);
      if (!m) return { error: `invalid --settings (want maxLines/maxBytes): ${v}` };
      opts.settings.push({ maxLines: Number(m[1]), maxBytes: Number(m[2]) });
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  return opts;
}

/** Ordered, de-duplicated settings list: default, current, then explicit. */
function settingsFor(opts) {
  const all = [
    { label: 'default', maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES },
    { label: 'current', maxLines: CURRENT_MAX_LINES, maxBytes: CURRENT_MAX_BYTES },
    ...opts.settings.map((s) => ({ label: 'explicit', ...s })),
  ];
  const seen = new Set();
  return all.filter((s) => {
    const key = `${s.maxLines}/${s.maxBytes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: measure-tool-output.cjs [--store DIR] [--json] [--settings MAX_LINES/MAX_BYTES]...');
    return 0;
  }

  const scan = scanStore(opts.store);
  if (scan.error) { console.error(`  \u2717  ${scan.error}`); return 1; }

  const marker = markerFor(opts.store);
  const settings = settingsFor(opts);
  const projections = settings.map((s) => ({ label: s.label, ...project(scan, s.maxLines, s.maxBytes, marker) }));

  const overDefaultBytes = scan.files.filter((f) => f.bytes > DEFAULT_MAX_BYTES).length;
  const totalBytes = scan.files.reduce((n, f) => n + f.bytes, 0);
  const baseline = projections[0];

  if (opts.json) {
    console.log(JSON.stringify({
      store: opts.store,
      scanned: scan.files.length,
      readErrors: scan.readErrors,
      totalBytes,
      overDefaultBytes,
      projections,
    }, null, 2));
    return 0;
  }

  console.log(`tool-output retained-preview projection (${opts.store})`);
  console.log(`  store: ${scan.files.length} files, ${(totalBytes / 1024).toFixed(0)} KiB total; ${overDefaultBytes} exceed the ${DEFAULT_MAX_BYTES}B default byte cap`);
  if (scan.readErrors > 0) {
    console.log(`  warning: ${scan.readErrors} file(s) unreadable; projection is a lower bound`);
  }
  console.log('  settings           retained    spill/inline   vs default');
  for (const p of projections) {
    const pct = baseline.retainedBytes === 0 ? 0 : (1 - p.retainedBytes / baseline.retainedBytes) * 100;
    const tag = p.label === 'default' ? '' : `  ${pct >= 0 ? '-' : '+'}${Math.abs(pct).toFixed(1)}%`;
    console.log(`  ${`${p.maxLines}/${p.maxBytes}`.padEnd(16)} ${(p.retainedBytes / 1024).toFixed(0).padStart(7)} KiB   ${String(p.spilled).padStart(3)}/${String(p.inlined).padEnd(3)}${tag}`);
  }
  console.log('  note: retained bytes is a proxy for context cost, not a measured effect (see ledger n=8).');
  return 0;
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  CURRENT_MAX_LINES,
  CURRENT_MAX_BYTES,
  takePrefix,
  takeSuffix,
  preview,
  boundedPreview,
  markerFor,
  scanStore,
  retainedBytes,
  project,
  parseArgs,
  settingsFor,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
