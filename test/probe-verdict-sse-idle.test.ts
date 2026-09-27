import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { classifySseIdleHold, type SseIdleHoldFacts } from "../src/integrations/probe-verdicts.js";

/**
 * The SSE idle-hold classifier — the survival decision of the
 * `acp-remote-sse-idle` arm in test/acp-remote-sse-probe.test.ts, extracted
 * into `classifySseIdleHold` (src/integrations/probe-verdicts.ts) so the
 * normal suite pins it.
 *
 * Why this file exists: that arm only runs under its live gate, for four
 * minutes, against a real remote server. Its decision conditions used to be
 * inline asserts inside it, so nothing a reviewer or CI runs in a minute could
 * tell whether the arm still refused a dropped stream, a silently resumed
 * stream, or a window that closed early. Every case below is decided in
 * microseconds, and the last test keeps the live arm wired to the shared
 * decision rather than back to an inline copy of it.
 */

/** Repo root: one level up from this test file's directory. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The live arm's window: 4 minutes with no events. */
const IDLE_WINDOW_MS = 240_000;

/** A clean hold: one subscription, the whole window, no events, no drop. */
const cleanHold: SseIdleHoldFacts = {
  heldMs: IDLE_WINDOW_MS,
  idleWindowMs: IDLE_WINDOW_MS,
  delivered: 0,
  subscriptions: 1,
  openedBefore: 1,
};

test("a clean 240s hold survives: one subscription, the whole window, no events", () => {
  const verdict = classifySseIdleHold(cleanHold);
  assert.equal(verdict.outcome, "survived");
  assert.equal(verdict.survived, true);
  assert.equal(verdict.eventFree, true, "no event during the window is the premise the arm exists to test");
  assert.equal(verdict.delivered, 0);
  assert.match(verdict.reason, /240000ms/);
});

test("a mid-window drop fails: the ingress ended or errored the idle stream", () => {
  for (const drop of ["the event stream ended", "the event stream errored: socket hang up"]) {
    const verdict = classifySseIdleHold({ ...cleanHold, drop });
    assert.equal(verdict.outcome, "dropped", `drop "${drop}" must not read as a survival`);
    assert.equal(verdict.survived, false);
    assert.match(verdict.reason, new RegExp(drop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // A drop is decided on its own, whatever else the window saw.
  assert.equal(classifySseIdleHold({ ...cleanHold, delivered: 4, drop: "the event stream ended" }).outcome, "dropped");
});

test("a second text/event-stream subscription fails as a silent resume", () => {
  const verdict = classifySseIdleHold({ ...cleanHold, subscriptions: 2 });
  assert.equal(verdict.outcome, "resumed", "a probe that never re-opens the stream cannot see two subscriptions");
  assert.equal(verdict.survived, false);
  assert.match(verdict.reason, /2 SSE subscriptions during one idle window \(1 at the start\)/);
  // Fail-closed on a counter that moved the other way: a broken measurement
  // is never a pass either.
  assert.equal(classifySseIdleHold({ ...cleanHold, subscriptions: 0, openedBefore: 1 }).survived, false);
});

test("a short hold fails as probe integrity, ahead of any transport finding", () => {
  const short = classifySseIdleHold({ ...cleanHold, heldMs: 90_000 });
  assert.equal(short.outcome, "short-hold");
  assert.equal(short.survived, false);
  assert.match(short.reason, /a short hold proves nothing/);
  // Probe integrity is reported FIRST: a window cut short can manufacture the
  // drop it also reports, and calling that an ingress failure would be a false
  // finding about a live server.
  assert.equal(classifySseIdleHold({ ...cleanHold, heldMs: 90_000, drop: "the event stream ended" }).outcome, "short-hold");
  // Sub-second timer jitter is tolerated; a real truncation is not.
  assert.equal(classifySseIdleHold({ ...cleanHold, heldMs: IDLE_WINDOW_MS - 1_000 }).survived, true);
  assert.equal(classifySseIdleHold({ ...cleanHold, heldMs: IDLE_WINDOW_MS - 1_001 }).outcome, "short-hold");
});

test("a stream that never opened cannot survive its window", () => {
  const verdict = classifySseIdleHold({ ...cleanHold, openedBefore: 0, subscriptions: 0 });
  assert.equal(verdict.outcome, "never-opened");
  assert.equal(verdict.survived, false, "zero subscriptions opened and zero seen must not read as a survival");
  assert.match(verdict.reason, /ever opened/);
});

test("events delivered during the window are reported honestly, not failed", () => {
  const verdict = classifySseIdleHold({ ...cleanHold, delivered: 3 });
  assert.equal(verdict.outcome, "survived", "a noisy window still measures transport survival");
  assert.equal(verdict.delivered, 3);
  assert.equal(verdict.eventFree, false, "a non-event-free window must not be banked as a clean idle hold");
  assert.match(verdict.reason, /3 event\(s\) delivered/);
});

test("garbled facts are rejected fail-closed instead of classified", () => {
  assert.throws(() => classifySseIdleHold({ ...cleanHold, heldMs: Number.NaN }), /heldMs must be a non-negative/);
  assert.throws(() => classifySseIdleHold({ ...cleanHold, heldMs: -1 }), /heldMs must be a non-negative/);
  assert.throws(() => classifySseIdleHold({ ...cleanHold, idleWindowMs: 0 }), /idleWindowMs must be a positive/);
  assert.throws(() => classifySseIdleHold({ ...cleanHold, delivered: 1.5 }), /delivered must be a non-negative integer/);
  assert.throws(() => classifySseIdleHold({ ...cleanHold, subscriptions: -1 }), /subscriptions must be a non-negative integer/);
  assert.throws(() => classifySseIdleHold({ ...cleanHold, openedBefore: Number.NaN }), /openedBefore must be a non-negative integer/);
});

test("anti-drift: the live idle arm keeps using the shared decision, not an inline copy", () => {
  const source = readFileSync(join(ROOT, "test", "acp-remote-sse-probe.test.ts"), "utf8");
  assert.match(
    source,
    /classifySseIdleHold\(/,
    "the gated arm must classify its hold through the shared function, or its conditions go unpinned again",
  );
  assert.match(source, /from "\.\.\/src\/integrations\/probe-verdicts\.js"/);
  // Exactly one place may decide the finding: if these messages reappear in the
  // probe, the decision has been forked back into the unexercised arm.
  for (const decision of ["the ingress dropped the idle stream", "the stream silently resumed", "a short hold proves nothing"]) {
    assert.doesNotMatch(
      source,
      new RegExp(decision),
      `"${decision}" is classified in src/integrations/probe-verdicts.ts — do not re-inline it in the gated arm`,
    );
  }
});
