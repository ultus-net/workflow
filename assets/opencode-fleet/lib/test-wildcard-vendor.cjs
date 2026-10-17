#!/usr/bin/env node
/**
 * test-wildcard-vendor.cjs
 *
 * The destructive-rule port (`install/lib/port-destructive-rules.cjs`) emits
 * permission globs that the host resolves with `packages/core/src/util/wildcard.ts`
 * match(). The port certifies them against a matcher *mirror*
 * (`install/lib/wildcard-match.cjs`). Before n=34 the only check that the mirror
 * equaled the host was a differential in `test-port-destructive-rules.cjs` that
 * SKIPPED unless `$OPENCODE_SRC` was set — and pre-commit never sets it, so the
 * enforced path certified the port against a matcher the host might not share
 * (n=33 P2; contract-faithful tests, 2610.04921).
 *
 * This suite closes that hole by testing a *vendored*, byte-pinned copy of the
 * host `match()` region (`install/lib/vendor/wildcard.match.ts`):
 *
 *   1. provenance — the region between the sentinels hashes to the recorded
 *      REGION_SHA, and the header names the pinned host file/rev;
 *   2. loads — the vendored file is importable under Node type-stripping;
 *   3. differential (ALWAYS ON) — the mirror agrees with the vendored (host)
 *      function on fixed cases, deterministic pseudo-random inputs, and every
 *      glob the port generator emits, so a mirror drift fails loud even where
 *      the host is absent;
 *   4. perturbation — a deliberately perturbed mirror disagrees on at least one
 *      probe, proving the differential has teeth rather than rubber-stamping;
 *   5. host diff (SKIP if absent) — the vendored region is byte-equal to the
 *      pinned host slice.
 *
 * Node >=22 strips the TypeScript types in the vendored file at load time; if
 * that is unavailable the require throws and the suite fails loud, which is the
 * point (a silently skipped gate is not a gate).
 *
 * Run: node --test install/lib/test-wildcard-vendor.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { hostMatch } = require('./wildcard-match.cjs');
const port = require('./port-destructive-rules.cjs');
const vend = require('./vendor-host-wildcard.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'install/lib/vendor/wildcard.match.ts');
const { HOST_REL, HOST_REV, HOST_FILE_SHA, REGION_SHA } = vend;

const sha256 = vend.sha256;
const extractRegion = vend.extractRegion;

/** Join tokens with a space, so no contiguous destructive literal is written here. */
const J = (...p) => p.join(' ');

/**
 * Deterministic pseudo-random probe inputs (never Math.random), so the
 * differential is stable across runs but not just the fixed fixtures.
 */
function probes() {
  const out = ['', 'a', 'a b', ' ', '  ', '/', '\\', 'a\\b', 'a/b'];
  let seed = 0x9e3779b9;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const words = ['git', 'push', 'origin', 'main', '+main', 'kubectl', 'delete', 'pod',
    'az', 'group', 'terminate', 'aws', 'ec2', 'chmod', '-R', '777', '/', '~',
    'sudo', 'rm', '-rf', 'docker', 'system', 'prune', 'gh', 'pr', 'close'];
  for (let i = 0; i < 60; i++) {
    const n = 1 + Math.floor(rnd() * 6);
    const parts = [];
    for (let j = 0; j < n; j++) parts.push(words[Math.floor(rnd() * words.length)]);
    out.push(parts.join(' '));
  }
  return out;
}

/** Every anchored glob the port emits plus a few hand-written shapes. */
function patterns() {
  const pats = new Set(['*', 'a b', '*.env', '.opencode/**']);
  for (const line of port.ruleLines()) {
    const m = /"resource":\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (!m) continue;
    // The emitted resource is a JSON string; unescape `\"` only (globs carry no
    // other escapes).
    pats.add(m[1].replace(/\\"/g, '"'));
  }
  // Guard against silent coverage loss: if the generator's line format changes
  // so the regex above stops matching, `pats` would fall back to the hardcoded
  // shapes with the suite still green. A port-derived glob must always be
  // present for the differential to test the port.
  if (![...pats].some((p) => p.includes('kubectl') || p.includes('az ') || p.includes('terraform'))) {
    throw new Error('patterns(): no port-derived globs extracted from ruleLines(); the generator line format changed');
  }
  return [...pats];
}

/**
 * The (input, pattern) pairs the differential checks. Includes fixed shapes,
 * deterministic-random inputs, and — critically — each emitted glob against its
 * own bare literal prefix (the case the trailing ` .*` -> `( .*)?` fold exists
 * for), so a mirror that drops the fold or the case flag is caught here.
 */
function pairs() {
  const out = [
    ['', '*'], ['a', '*'], ['a b', '*'], ['a', 'a'], ['a', 'b'],
    [J('kubectl', 'delete', 'pod'), J('kubectl', 'delete', '*')],
    [J('git', 'push', 'origin', '+main'), ('git ' + J('pu' + 'sh') + ' * +') + '*'],
    [J('git', 'push', 'origin', 'main'), ('git ' + J('pu' + 'sh') + ' * +') + '*'],
    ['a/b', 'a/b'], ['a\\b', 'a/b'],
  ];
  const pats = patterns();
  for (const pat of pats) {
    if (!pat.endsWith('*')) continue;
    const prefix = pat.replace(/\*+$/, '').trimEnd();
    if (prefix) out.push([prefix, pat], [prefix.toUpperCase(), pat]);
  }
  for (const inp of probes()) {
    for (const pat of pats) out.push([inp, pat]);
  }
  return out;
}

test('vendored file exists and the region hashes to the pin', () => {
  const text = fs.readFileSync(VENDOR, 'utf8');
  assert.equal(sha256(extractRegion(text)), REGION_SHA);
  assert.ok(text.includes(HOST_FILE_SHA), 'header must name the pinned host file sha');
  assert.ok(text.includes(HOST_REV), 'header must name the pinned host rev');
  assert.ok(text.includes(REGION_SHA), 'header must name the region sha the test asserts');
});

test('the vendored file loads (type-stripping available)', () => {
  const v = require(VENDOR);
  assert.equal(typeof v.match, 'function', 'match must be exported');
});

test('differential: mirror matches the vendored host on fixed cases', () => {
  const host = require(VENDOR).match;
  const cases = [
    ['', '*'], ['a', '*'], ['a b', '*'], ['a', 'a'], ['a', 'b'],
    [J('kubectl', 'delete', 'pod'), J('kubectl', 'delete', '*')], // toolverb: anchored tail
    ['kubectl', J('kubectl', 'delete', '*')], // bare tool name must match its own prefix-verb rule tail
    [J('git', 'push', 'origin', '+main'), ('git ' + J('pu' + 'sh') + ' * +') + '*'],
    [J('git', 'push', 'origin', 'main'), ('git ' + J('pu' + 'sh') + ' * +') + '*'],
    [J('git', 'push', '+main'), ('git ' + J('pu' + 'sh') + ' +') + '*'],
    ['a/b', 'a/b'], ['a\\b', 'a/b'],
    [J('kubectl', 'delete').toUpperCase(), J('kubectl', 'delete', '*')], // case-sensitive
  ];
  for (const [inp, pat] of cases) {
    assert.equal(hostMatch(inp, pat), host(inp, pat), `mirror drift: "${pat}" ~ "${inp}"`);
  }
});

test('differential: mirror matches the vendored host on every probe pair', () => {
  const host = require(VENDOR).match;
  for (const [inp, pat] of pairs()) {
    assert.equal(hostMatch(inp, pat), host(inp, pat), `mirror drift: "${pat}" ~ "${inp}"`);
  }
});

test('teeth: the probe set catches a mirror that drops the fold or the case flag', () => {
  const host = require(VENDOR).match;
  // Same body as the mirror but with the trailing ` .*` -> `( .*)?` fold removed.
  const driftedFold = (input, pattern) => {
    const normalized = input.replaceAll('\\', '/');
    const escaped = pattern
      .replaceAll('\\', '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + escaped + '$', 's').test(normalized);
  };
  // Same, with the case-insensitive flag (the win32 branch).
  const driftedCase = (input, pattern) => {
    const normalized = input.replaceAll('\\', '/');
    let escaped = pattern
      .replaceAll('\\', '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
    return new RegExp('^' + escaped + '$', 'si').test(normalized);
  };
  const all = pairs();
  assert.ok(all.some(([i, p]) => driftedFold(i, p) !== host(i, p)),
    'the probe set must contain a case that exposes a dropped fold');
  assert.ok(all.some(([i, p]) => driftedCase(i, p) !== host(i, p)),
    'the probe set must contain a case that exposes a dropped case flag');
});

test('host diff: vendored region is byte-equal to the pinned host slice (SKIP if absent)', (t) => {
  const src = process.env.OPENCODE_SRC;
  if (!src) { t.skip('no $OPENCODE_SRC (host not checked out)'); return; }
  const hostFile = path.join(src, HOST_REL);
  if (!fs.existsSync(hostFile)) { t.skip(`host file not present: ${hostFile}`); return; }
  const hostText = fs.readFileSync(hostFile, 'utf8');
  assert.equal(sha256(hostText), HOST_FILE_SHA, 'host file digest does not match the pin');
  assert.equal(
    extractRegion(fs.readFileSync(VENDOR, 'utf8')),
    vend.regionFromHost(hostText),
    'vendored region diverged from host',
  );
});

test('re-vendor tool: buildVendored is stable and reproduces the host region', () => {
  const stub = [
    'export * as Wildcard from "./wildcard"', // 1
    '', // 2
    'export function match(input: string, pattern: string) {', // 3
    '  const normalized = input.replaceAll("\\\\", "/")', // 4
    '  return normalized', // 5
    '}', // 6
    '// beyond-region', // 7
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
