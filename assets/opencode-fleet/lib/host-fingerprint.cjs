#!/usr/bin/env node
/**
 * host-fingerprint.cjs
 *
 * The n=12 ruler (`measure-tool-output.cjs`) ports the host's preview math
 * (`bound()`/`preview()`/`boundedPreview()`) and is only valid against the host
 * revision it was ported from. That pin lived in prose (`opencode-src` rev
 * `3dd1b305`, a header comment). A host change to those functions would
 * silently invalidate the port and every projection built on it, and only a
 * fixture on a *vendored* copy could catch it. This checker turns the prose
 * pin into a machine-checkable contract: a file digest plus the exact source
 * markers the port depends on.
 *
 * Contract (mirrors verify-effective-model.cjs):
 *   - the host source directory is not present      -> SKIP (exit 0). The tool
 *     is inert where the host is not checked out; absence of data is not a
 *     failure.
 *   - the directory is present but a pinned file is missing/unreadable, its
 *     digest differs, or a source marker is gone      -> DRIFT (exit 1). A
 *     present-but-diverged host must fail loud, not pass.
 *   - all pinned files match                           -> OK (exit 0).
 *
 * The digest is the primary signal; the markers are a defensive second check
 * (a digest match already implies the bytes, so a marker miss is only reachable
 * if the digests were updated without updating the markers).
 *
 * Updating the pin is a deliberate act: re-derive with `--emit`, review the
 * host diff, then update HOST_FILES and re-run the ruler's fixtures.
 *
 * Usage:
 *   node install/lib/host-fingerprint.cjs [--src DIR] [--json]
 *   node install/lib/host-fingerprint.cjs --emit [--src DIR]
 *
 * Default --src is $OPENCODE_SRC; if that is unset the run is a SKIP.
 *
 * Exit codes: 0 = ok or skip, 1 = drift or a present-but-unreadable host, 2 =
 * usage error.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The pinned host revision. Kept as documentation; the authoritative signal is
// the file digest below.
const HOST_REV = '3dd1b3053979971d8eb03ef37b29de07b892d95c';

// Files the ruler ports, with the digest at HOST_REV and the source markers the
// port depends on. `measure-tool-output.cjs` ports preview/boundedPreview from
// tool-output-store.ts.
const HOST_FILES = [
  {
    path: 'packages/core/src/tool-output-store.ts',
    sha256: '3eea248408c62f7ce4c56433dabdbabf8507095dda812b41a1e1168b713536b2',
    markers: [
      'export const MAX_LINES = 2_000',
      'export const MAX_BYTES = 50 * 1024',
      'const preview = (text: string, maxLines: number, maxBytes: number)',
      'const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number)',
    ],
  },
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Check one pinned file against the host source. */
function checkFile(srcDir, entry) {
  const full = path.join(srcDir, entry.path);
  if (!fs.existsSync(full)) {
    return { ok: false, reason: 'missing', path: entry.path };
  }
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'unreadable', path: entry.path, detail: err.message };
  }
  const actualSha = sha256(Buffer.from(text, 'utf8'));
  if (actualSha !== entry.sha256) {
    return { ok: false, reason: 'digest', path: entry.path, expected: entry.sha256, actual: actualSha };
  }
  const missingMarkers = entry.markers.filter((m) => !text.includes(m));
  if (missingMarkers.length > 0) {
    return { ok: false, reason: 'markers', path: entry.path, missingMarkers };
  }
  return { ok: true, path: entry.path, sha256: actualSha };
}

/**
 * Verify the host source at `srcDir`. Returns:
 *   { status: 'skip',  reason }
 *   { status: 'ok',    checked, details }
 *   { status: 'drift', checked, details }
 */
function verifyHost(srcDir) {
  if (!srcDir) {
    return { status: 'skip', reason: 'no host source (set --src or $OPENCODE_SRC)' };
  }
  if (!fs.existsSync(srcDir)) {
    return { status: 'skip', reason: `host source not present: ${srcDir}` };
  }
  let stat;
  try {
    stat = fs.statSync(srcDir);
  } catch (err) {
    return { status: 'drift', checked: 0, details: [{ ok: false, reason: 'unreadable', path: srcDir, detail: err.message }] };
  }
  if (!stat.isDirectory()) {
    return { status: 'drift', checked: 0, details: [{ ok: false, reason: 'not a directory', path: srcDir }] };
  }
  if (HOST_FILES.length === 0) {
    // An emptied pin list would otherwise report OK and enforce nothing.
    return { status: 'drift', checked: 0, details: [{ ok: false, reason: 'no pinned files', path: '(pin list empty)' }] };
  }
  const details = HOST_FILES.map((entry) => checkFile(srcDir, entry));
  const drifted = details.some((d) => !d.ok);
  return { status: drifted ? 'drift' : 'ok', checked: details.length, details };
}

function emitPins(srcDir) {
  return HOST_FILES.map((entry) => {
    const full = path.join(srcDir, entry.path);
    const text = fs.readFileSync(full, 'utf8');
    return { path: entry.path, sha256: sha256(Buffer.from(text, 'utf8')) };
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { src: process.env.OPENCODE_SRC || null, json: false, emit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') {
      const v = argv[++i];
      if (v == null) return { error: '--src requires a directory' };
      opts.src = v;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--emit') {
      opts.emit = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: host-fingerprint.cjs [--src DIR] [--json] [--emit]');
    return 0;
  }

  if (opts.emit) {
    if (!opts.src || !fs.existsSync(opts.src)) {
      console.error(`cannot emit: host source not present: ${opts.src || '(unset)'}`);
      return 1;
    }
    const missing = HOST_FILES.filter((e) => {
      const full = path.join(opts.src, e.path);
      try {
        return !fs.statSync(full).isFile();
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      console.error(`cannot emit: pinned file(s) not found or not regular files: ${missing.map((e) => e.path).join(', ')}`);
      return 1;
    }
    const pins = emitPins(opts.src);
    console.log(opts.json ? JSON.stringify({ rev: HOST_REV, pins }, null, 2)
                          : pins.map((p) => `${p.sha256}  ${p.path}`).join('\n'));
    return 0;
  }

  const r = verifyHost(opts.src);
  if (opts.json) {
    console.log(JSON.stringify({ rev: HOST_REV, source: opts.src, ...r }, null, 2));
    return r.status === 'drift' ? 1 : 0;
  }

  if (r.status === 'skip') {
    console.log(`host fingerprint: SKIP — ${r.reason}`);
    return 0;
  }
  if (r.status === 'ok') {
    console.log(`host fingerprint: OK — ${r.checked} file(s) match rev ${HOST_REV.slice(0, 12)}`);
    return 0;
  }
  console.log(`host fingerprint: DRIFT — the n=12 preview port may be invalid (rev ${HOST_REV.slice(0, 12)})`);
  for (const d of r.details.filter((x) => !x.ok)) {
    if (d.reason === 'digest') {
      console.log(`  ${d.path}: sha256 ${d.actual} != pinned ${d.expected}`);
    } else if (d.reason === 'markers') {
      console.log(`  ${d.path}: missing marker(s): ${d.missingMarkers.join(' | ')}`);
    } else {
      console.log(`  ${d.path}: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`);
    }
  }
  console.log('  re-derive with --emit, review the host diff, then update HOST_FILES.');
  return 1;
}

module.exports = {
  HOST_REV,
  HOST_FILES,
  sha256,
  checkFile,
  verifyHost,
  emitPins,
  parseArgs,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
