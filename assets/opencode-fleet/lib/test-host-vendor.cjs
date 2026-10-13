#!/usr/bin/env node
/**
 * test-host-vendor.cjs
 *
 * The n=12 ruler ports the host's preview math and is guarded by
 * `host-fingerprint.cjs` — but that checker SKIPs wherever the host source is
 * not checked out (i.e. CI), so a host change to those functions is invisible by
 * default. This suite closes that hole by testing a *vendored* copy of the host
 * region (`install/lib/vendor/tool-output-store.preview.ts`):
 *
 *   1. provenance — the region between the sentinels in the vendored file hashes
 *      to the recorded `REGION_SHA`, and the header's file sha names the pinned
 *      host file;
 *   2. host diff (when OPENCODE_SRC is set) — the vendored region is byte-equal
 *      to the pinned host slice, so a host edit that is re-vendored shows here;
 *   3. differential — the ruler's exported `takePrefix`/`takeSuffix`/`preview`/
 *      `boundedPreview` agree with the vendored (host) functions on arbitrary
 *      inputs, so a drift between the port and the source fails loud even where
 *      the host is absent.
 *
 * Node >=22 strips the TypeScript types in the vendored file at load time; if
 * that is unavailable the require throws and the suite fails loud, which is the
 * point (a silently skipped gate is not a gate).
 *
 * Run: node --test install/lib/test-host-vendor.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ruler = require('./measure-tool-output.cjs');
const vend = require('./vendor-host-preview.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'install/lib/vendor/tool-output-store.preview.ts');
const { HOST_REL, HOST_REV, HOST_FILE_SHA, REGION_SHA } = vend;

const sha256 = vend.sha256;
const extractRegion = vend.extractRegion;

/** Deterministic pseudo-random inputs so the differential is not the fixed fixtures. */
function inputs() {
  let seed = 0x9e3779b9;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = ['', 'a', 'a\n', 'a\nb\nc', '\n\n\n', 'x'.repeat(1), 'x'.repeat(200000)];
  for (let i = 0; i < 40; i++) {
    const n = 1 + Math.floor(rnd() * 40);
    const parts = [];
    for (let j = 0; j < n; j++) {
      const len = Math.floor(rnd() * 200);
      const ch = rnd() < 0.2 ? 'é中' : 'ab \t,.';
      parts.push(ch.repeat(Math.max(0, Math.floor(len / ch.length))));
    }
    out.push(parts.join('\n'));
  }
  return out;
}

const CAPS = [[8, 100], [2000, 51200], [800, 40000], [4, 100], [3, 100], [10, 5], [1, 1], [100, 100000]];

test('vendored file exists and the region hashes to the pin', () => {
  const text = fs.readFileSync(VENDOR, 'utf8');
  assert.equal(sha256(extractRegion(text)), REGION_SHA);
  assert.ok(text.includes(HOST_FILE_SHA), 'header must name the pinned host file sha');
  assert.ok(text.includes(HOST_REV), 'header must name the pinned host rev');
  assert.ok(text.includes(REGION_SHA), 'header must name the region sha the test asserts');
});

test('the vendored file loads (type-stripping available)', () => {
  const v = require(VENDOR);
  assert.equal(v.MAX_LINES, 2000);
  assert.equal(v.MAX_BYTES, 50 * 1024);
  for (const fn of ['takePrefix', 'takeSuffix', 'preview', 'boundedPreview', 'lineCount']) {
    assert.equal(typeof v[fn], 'function', `${fn} must be exported`);
  }
});

test('differential: port matches the vendored host on arbitrary inputs', () => {
  const v = require(VENDOR);
  const marker = '... output truncated; full content saved to /store/tool_x ...';
  for (const text of inputs()) {
    assert.equal(v.lineCount(text), text.split('\n').length, 'lineCount');
    for (const [ml, mb] of CAPS) {
      assert.deepEqual(ruler.preview(text, ml, mb), v.preview(text, ml, mb), `preview ${ml}/${mb}`);
      assert.deepEqual(
        ruler.boundedPreview(text, marker, ml, mb),
        v.boundedPreview(text, marker, ml, mb),
        `boundedPreview ${ml}/${mb}`,
      );
    }
  }
});

test('differential: takePrefix/takeSuffix match on multibyte boundaries', () => {
  const v = require(VENDOR);
  const s = 'aé中🙂bc';
  for (let n = 0; n <= 12; n++) {
    assert.equal(ruler.takePrefix(s, n), v.takePrefix(s, n), `prefix ${n}`);
    assert.equal(ruler.takeSuffix(s, n), v.takeSuffix(s, n), `suffix ${n}`);
  }
});

test('host diff: vendored region is byte-equal to the pinned host slice (SKIP if absent)', (t) => {
  const src = process.env.OPENCODE_SRC;
  if (!src) {
    t.skip('no $OPENCODE_SRC (host not checked out)');
    return;
  }
  const hostFile = path.join(src, HOST_REL);
  if (!fs.existsSync(hostFile)) {
    t.skip(`host file not present: ${hostFile}`);
    return;
  }
  const hostText = fs.readFileSync(hostFile, 'utf8');
  assert.equal(sha256(hostText), HOST_FILE_SHA, 'host file digest does not match the pin');
  assert.equal(extractRegion(fs.readFileSync(VENDOR, 'utf8')), vend.regionFromHost(hostText), 'vendored region diverged from host');
});

test('re-vendor tool: buildVendored is stable and reproduces the host region', () => {
  // A two-line host stub proves the extraction/wrapping plumbing without the host.
  const stub = [
    'export const MAX_LINES = 2_000', // 1
    'export const MAX_BYTES = 50 * 1024', // 2
    ...Array.from({ length: 47 }, (_, i) => `// pad ${i}`), // 3..49
    'const takePrefix = (input) => input', // 50
    ...Array.from({ length: 60 }, (_, i) => `// body ${i}`), // 51..110
    '// beyond-region', // 111
  ].join('\n');
  const built = vend.buildVendored(stub);
  assert.equal(extractRegion(built), vend.regionFromHost(stub), 'region must equal the host slice verbatim');
  assert.equal(vend.buildVendored(stub), built, 'buildVendored must be deterministic');
  assert.ok(built.startsWith('/**'), 'must carry the provenance header');
});

test('the vendor tool and host-fingerprint.cjs name the same host file/rev', () => {
  // Re-vendoring updates the vendor tool's pins; the fingerprint checker holds
  // its own copy. If they diverge, one was bumped without the other.
  const fp = require('./host-fingerprint.cjs');
  assert.equal(fp.HOST_REV, HOST_REV, 'HOST_REV drifted between the two pins');
  const entry = fp.HOST_FILES.find((e) => e.path === HOST_REL);
  assert.ok(entry, `host-fingerprint must pin ${HOST_REL}`);
  assert.equal(entry.sha256, HOST_FILE_SHA, 'HOST_FILE_SHA drifted between the two pins');
});

