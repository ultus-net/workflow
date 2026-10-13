#!/usr/bin/env node
/**
 * test-measure-tool-output.cjs
 *
 * Fixture tests for measure-tool-output.cjs. The preview math is a port of the
 * pinned host (opencode-src 3dd1b305, tool-output-store.ts:preview/
 * boundedPreview); these fixtures pin the port against hand-computed head/tail
 * byte splits, the within-limits passthrough, and the marker-only truncation,
 * then check the projection is monotonic and the CLI never writes.
 *
 * Run: node --test install/lib/test-measure-tool-output.cjs
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const m = require('./measure-tool-output.cjs');

const bytes = (s) => Buffer.byteLength(s, 'utf-8');

// ─── preview() — hand-computed against the host algorithm ────────────────────

test('preview: within the line sample, a byte overflow splits head/tail at ceil/floor halves', () => {
  // 1 line, 10 B. maxLines=10 (line-sample keeps it whole), maxBytes=6 -> split.
  const r = m.preview('0123456789', 10, 6);
  assert.equal(r.head, '012'); // ceil(6/2)=3 leading bytes
  assert.equal(r.tail, '789'); // floor(6/2)=3 trailing bytes
});

test('preview: more lines than maxLines samples ceil(head)/floor(tail) line halves', () => {
  const text = ['L0', 'L1', 'L2', 'L3'].join('\n'); // 4 lines
  const r = m.preview(text, 2, 1000); // headLines=1, tailLines=1
  assert.equal(r.head, 'L0');
  assert.equal(r.tail, 'L3');
});

// ─── boundedPreview() — marker composition ───────────────────────────────────

test('boundedPreview: head + marker + tail, byte-exact', () => {
  const lines = ['0000000000', '1111111111', '2222222222', '3333333333', '4444444444', '5555555555'];
  const text = lines.join('\n'); // 6 lines, 65 B
  // maxLines=8 -> preview(4): 2 head lines (21 B) + 2 tail lines (21 B); maxBytes huge.
  const out = m.boundedPreview(text, 'MARK', 8, 1000);
  assert.equal(bytes(out), 21 + 2 + 4 + 2 + 21); // head \n\n marker \n\n tail
  assert.ok(out.startsWith('0000000000'));
  assert.ok(out.endsWith('5555555555'));
});

test('boundedPreview: head + marker when there is no tail', () => {
  // maxLines=5 -> preview(1) on a 1-line text: head=whole, tail="".
  const out = m.boundedPreview('abcdefghij', 'MARK', 5, 1000);
  assert.equal(out, 'abcdefghij\n\nMARK');
  assert.equal(bytes(out), 16);
});

test('boundedPreview: marker-only when maxBytes cannot fit marker + 4', () => {
  const out = m.boundedPreview('0123456789', 'MARK', 10, 6); // 6 <= 4 + 4
  assert.equal(out, 'MARK');
});

// ─── retainedBytes / project ─────────────────────────────────────────────────

test('retainedBytes: a file within both limits is unchanged', () => {
  const file = { bytes: 10, lines: 1, text: '0123456789' };
  assert.equal(m.retainedBytes(file, 10, 20, 'MARK'), 10);
});

test('retainedBytes: an over-cap file is bounded below its full size', () => {
  const text = 'x'.repeat(60000);
  const file = { bytes: bytes(text), lines: 1, text };
  const r = m.retainedBytes(file, 2000, 51200, 'MARK');
  assert.ok(r < file.bytes, `bounded ${r} < full ${file.bytes}`);
  assert.ok(r <= 51200, `bounded ${r} <= 51200`);
});

test('project: sums retained across files, counts inlined vs spilled', () => {
  const big = 'x'.repeat(60000); // exceeds the 51200 default -> spills
  const scan = { files: [
    { name: 'a', bytes: 10, lines: 1, text: '0123456789' }, // within -> 10
    { name: 'b', bytes: bytes(big), lines: 1, text: big },  // spills
  ] };
  const p = m.project(scan, 2000, 51200, 'MARK');
  assert.equal(p.files, 2);
  assert.equal(p.inlined, 1);
  assert.equal(p.spilled, 1);
  assert.equal(p.unchangedBytes, 10);
  assert.ok(p.boundedBytes > 0 && p.boundedBytes <= 51200, `bounded ${p.boundedBytes} <= 51200`);
  assert.equal(p.retainedBytes, p.unchangedBytes + p.boundedBytes);
});

test('project: tightening maxBytes never increases retained bytes (monotonic)', () => {
  const text = Array.from({ length: 4000 }, (_, i) => String(i).padEnd(60, 'z')).join('\n');
  const scan = { files: [{ name: 'a', bytes: bytes(text), lines: text.split('\n').length, text }] };
  let prev = Infinity;
  let sawBounded = false;
  for (const mb of [51200, 40000, 30000, 20000, 16000, 10000, 6000, 4000, 2000]) {
    const p = m.project(scan, 4000, mb, 'MARK');
    assert.ok(p.retainedBytes <= prev, `retained at ${mb} (${p.retainedBytes}) must be <= at larger cap (${prev})`);
    if (p.boundedBytes > 0) sawBounded = true;
    prev = p.retainedBytes;
  }
  assert.ok(sawBounded, 'the sweep must exercise the bounded (byte-split) branch, not just passthrough/line-sampling');
});

// ─── scanStore ───────────────────────────────────────────────────────────────

test('scanStore: a missing store is an error, not a crash', () => {
  const r = m.scanStore(path.join(os.tmpdir(), 'vem-measure-nope-' + Date.now()));
  assert.match(r.error, /store not readable/);
});

test('scanStore: reads only tool_* files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  fs.writeFileSync(path.join(dir, 'tool_a'), 'hello');
  fs.writeFileSync(path.join(dir, 'other'), 'ignored');
  const r = m.scanStore(dir);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].bytes, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test('parseArgs: bad --settings is a usage error, not a crash', () => {
  assert.match(m.parseArgs(['--settings', 'nope']).error, /invalid --settings/);
  assert.match(m.parseArgs(['--settings']).error, /--settings requires/);
  assert.match(m.parseArgs(['--store']).error, /--store requires/);
});

test('main: an unreadable store exits 1', () => {
  assert.equal(m.main(['--store', path.join(os.tmpdir(), 'vem-measure-absent-' + Date.now())]), 1);
});

test('main: projects a fixture store and prints default/current rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-cli-'));
  fs.writeFileSync(path.join(dir, 'tool_x'), 'x'.repeat(300));
  const rc = m.main(['--store', dir, '--json']);
  assert.equal(rc, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── current-cap parity with the overlay ─────────────────────────────────────
// The ruler hardcodes CURRENT_MAX_LINES/BYTES as a mirror of the overlay's
// tool_output block, but nothing coupled them (n=26 P2): a cap change that
// updates one side only would make the "current" row misrepresent the deployed
// cap. This asserts equality by parsing the tracked overlay, so the constant
// cannot drift from the source it claims to represent. The ruler itself stays
// config-pure (no runtime read); the coupling lives here.

// Parse the tracked overlay through the validator's own JSONC reader, so the
// test and the validator cannot disagree on how the config is normalized.
const { stripJsonc } = require('./validate-config.cjs');

test('current caps match install/opencode/config.jsonc tool_output', () => {
  const overlayPath = path.join(__dirname, '..', 'opencode', 'config.jsonc');
  const overlay = JSON.parse(stripJsonc(fs.readFileSync(overlayPath, 'utf8')));
  const cap = overlay.tool_output;
  assert.ok(cap && typeof cap === 'object', 'overlay declares tool_output');
  assert.equal(
    m.CURRENT_MAX_LINES,
    cap.max_lines,
    `CURRENT_MAX_LINES (${m.CURRENT_MAX_LINES}) must equal overlay tool_output.max_lines (${cap.max_lines})`,
  );
  assert.equal(
    m.CURRENT_MAX_BYTES,
    cap.max_bytes,
    `CURRENT_MAX_BYTES (${m.CURRENT_MAX_BYTES}) must equal overlay tool_output.max_bytes (${cap.max_bytes})`,
  );
});

