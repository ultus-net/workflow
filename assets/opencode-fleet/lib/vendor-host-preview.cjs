#!/usr/bin/env node
/**
 * vendor-host-preview.cjs
 *
 * Re-vendor the host preview math, and hold the shared extraction used by
 * `test-host-vendor.cjs`. The n=12 ruler ports
 * `takePrefix`/`takeSuffix`/`preview`/`boundedPreview` from the host; the port is
 * only valid against the pinned host revision. Vendoring the region makes it
 * diff-testable without the host checked out (CI), which `host-fingerprint.cjs`
 * cannot do because it SKIPs when the host is absent.
 *
 * Re-vendoring is a deliberate act (mirrors `host-fingerprint.cjs --emit`):
 *
 *   1. check out the host at the new revision;
 *   2. `node install/lib/vendor-host-preview.cjs --src DIR --write`  (writes the
 *      vendored file, bumping the header's rev/file/region hashes);
 *   3. update HOST_REV/HOST_FILE_SHA in this tool's defaults and in
 *      `host-fingerprint.cjs` if the file hash changed;
 *   4. update REGION_SHA from the tool's output;
 *   5. review the host diff and re-run `test-measure-tool-output.cjs` +
 *      `test-host-vendor.cjs`.
 *
 * Read-only by default: without `--write` it prints the region hash and the
 * would-be file to stdout. Exit codes: 0 = ok, 1 = error, 2 = usage error.
 *
 * Usage:
 *   node install/lib/vendor-host-preview.cjs --src DIR [--write] [--json]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Pinned provenance. These three must agree with the vendored header and with
// host-fingerprint.cjs's HOST_REV/HOST_FILES[0].sha256.
const HOST_REV = '3dd1b3053979971d8eb03ef37b29de07b892d95c';
const HOST_REL = 'packages/core/src/tool-output-store.ts';
const HOST_FILE_SHA = '3eea248408c62f7ce4c56433dabdbabf8507095dda812b41a1e1168b713536b2';
// The pure region the ruler ports: constants (13-14) and the function block
// (50-110). Both are 1-based inclusive.
const HOST_REGION_LINES = [[13, 14], [50, 110]];
// sha256 of the vendored region (the text between the sentinels).
const REGION_SHA = '2fc8b6788bf64bc6bf71604bd6364f7ef2c14d53f6bf937cd2148f6853f29bdf';

const START = '// >>> VENDORED REGION (verbatim)';
const END = '// <<< VENDORED REGION';

const VENDOR_DEST = path.join(__dirname, 'vendor', 'tool-output-store.preview.ts');

function sha256(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** The text between the sentinels (exclusive), byte-for-byte. */
function extractRegion(text) {
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s < 0 || e < 0 || e < s) throw new Error('vendored sentinels not found');
  // Between START and END the file holds "\n" + region (region ends with "\n").
  return text.slice(s + START.length, e).replace(/^\n/, '');
}

/** Host slice matching the vendored region: lines 13-14, blank, 50-110 + "\n". */
function regionFromHost(hostText) {
  const lines = hostText.split('\n');
  const pick = (a, b) => lines.slice(a - 1, b);
  return [...pick(...HOST_REGION_LINES[0]), '', ...pick(...HOST_REGION_LINES[1])].join('\n') + '\n';
}

/** Full vendored file for a host source, with the provenance header. */
function buildVendored(hostText) {
  const region = regionFromHost(hostText);
  const fileSha = sha256(hostText);
  const regionSha = sha256(region);
  const header = `/**
 * tool-output-store.preview.ts — VENDORED, DO NOT EDIT.
 *
 * The pure preview math from opencode-src, copied verbatim so the n=12 ruler's
 * port (\`install/lib/measure-tool-output.cjs\`) is diff-testable without the host
 * checked out. Guarded by \`install/lib/test-host-vendor.cjs\`; re-vendor with
 * \`install/lib/vendor-host-preview.cjs --src DIR --write\`. The region between the
 * sentinels must stay byte-identical to the host slice.
 *
 *   repo:  opencode-src
 *   rev:   ${HOST_REV}
 *   path:  ${HOST_REL}
 *   file:  sha256 ${fileSha}
 *   region: lines ${HOST_REGION_LINES.map((r) => r.join('-')).join(',')}  sha256 ${regionSha}
 *   license: MIT (c) 2025 opencode — see LICENSE-opencode-src
 *
 * Node >=22 strips the TypeScript types at load time, so this is runnable as-is;
 * if type-stripping is unavailable the import throws, which the fixture catches.
 */

`;
  const footer = `
export { takePrefix, takeSuffix, preview, boundedPreview, lineCount }
`;
  return `${header}${START}\n${region}${END}\n${footer}`;
}

function parseArgs(argv) {
  const opts = { src: process.env.OPENCODE_SRC || null, write: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') {
      const v = argv[++i];
      if (v == null) return { error: '--src requires a directory' };
      opts.src = v;
    } else if (a === '--write') opts.write = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(opts.error); return 2; }
  if (opts.help) {
    console.log('usage: vendor-host-preview.cjs --src DIR [--write] [--json]');
    return 0;
  }
  if (!opts.src) { console.error('cannot vendor: no --src and no $OPENCODE_SRC'); return 1; }
  const hostFile = path.join(opts.src, HOST_REL);
  if (!fs.existsSync(hostFile)) { console.error(`cannot vendor: host file not present: ${hostFile}`); return 1; }
  const hostText = fs.readFileSync(hostFile, 'utf8');
  const fileSha = sha256(hostText);
  const out = buildVendored(hostText);
  const regionSha = sha256(extractRegion(out));
  const provenance = { rev: HOST_REV, path: HOST_REL, fileSha, regionSha, dest: VENDOR_DEST };
  if (opts.write) {
    fs.writeFileSync(VENDOR_DEST, out);
    console.log(opts.json ? JSON.stringify({ ...provenance, wrote: true }, null, 2)
                          : `vendored -> ${VENDOR_DEST}\n  region sha256 ${regionSha}`);
    return 0;
  }
  // Dry run: compare against the on-disk copy so a drift is visible.
  let currentRegion = null;
  try {
    currentRegion = extractRegion(fs.readFileSync(VENDOR_DEST, 'utf8'));
  } catch { /* missing vendored file */ }
  const matchesCurrent = currentRegion !== null && sha256(currentRegion) === regionSha;
  console.log(opts.json ? JSON.stringify({ ...provenance, matchesCurrent }, null, 2)
                        : `region sha256 ${regionSha}\n  file sha256 ${fileSha}\n  on-disk region matches: ${matchesCurrent}`);
  return 0;
}

module.exports = {
  HOST_REV,
  HOST_REL,
  HOST_FILE_SHA,
  HOST_REGION_LINES,
  REGION_SHA,
  START,
  END,
  sha256,
  extractRegion,
  regionFromHost,
  buildVendored,
  parseArgs,
  main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
