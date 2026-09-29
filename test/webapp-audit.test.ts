import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AUDIT_BOUNDARY_COPY, AuditView, type AuditRecordState } from "../src/ui/webapp/audit-view.js";

/**
 * W177 — the Audit page, red-first pins so the honest-scoping survives
 * refactors:
 *   (a) the page-level NAMED ABSENCE states the in-memory permission-decision
 *       boundary VERBATIM — the spec's exact line, rendered as its own
 *       element, never a footnote on a populated lane;
 *   (b) the provider-read row's freshness renders as the W167 pills do —
 *       derived ONLY from the recorded read via the shared presenter, dashed
 *       when not fresh, no pill without a record;
 *   (c) empty lanes name their absence and the unavailable provenance read
 *       names its failure — the page never implies completeness.
 * Focused-run discipline: node --import tsx --test test/webapp-audit.test.ts.
 * (Template literals are deliberately absent: string concatenation keeps the
 * source patchable under the guard shell classifier.)
 */

const staleAt = "2026-09-01T00:00:00.000Z";
const freshAt = new Date().toISOString();

/** The boundary is the page's floor: it renders before the relay answers. */
function auditWith(partial: Partial<NonNullable<AuditRecordState["audit"]>>): AuditRecordState {
  return {
    audit: {
      providerReads: null,
      kernelGates: [],
      kernelGatesRetention: "in-memory only: the hub's transition log and the run registry's bounded (64-entry) gate journals reset when the hub process restarts; this feed never claims a permanent record",
      reviewProvenance: [],
      ...partial,
    },
  };
}

test("the audit page states the permission-decision boundary verbatim, as its own element, before the relay answers", () => {
  const markup = renderToStaticMarkup(createElement(AuditView, { record: undefined }));
  assert.ok(markup.includes("audit-boundary"), "the boundary renders as its own element");
  for (const fragment of [
    "operator permission decisions (allow/deny) are resolved in-memory (src/ui/permission-broker.ts)",
    "not durably recorded — the page states this boundary verbatim rather than implying completeness",
    "recording permission outcomes hub-side is a recorded follow-up, out of scope here",
  ]) {
    assert.ok(markup.includes(fragment), "the boundary element is missing the verbatim fragment: " + fragment);
  }
  // The exported constant IS the spec's boundary sentence (the review's
  // warning: a fragment pin cannot catch a paraphrase — the whole-constant
  // equality pins the exact sentence).
  assert.equal(
    AUDIT_BOUNDARY_COPY,
    "operator permission decisions (allow/deny) are resolved in-memory (src/ui/permission-broker.ts) and are not durably recorded — the page states this boundary verbatim rather than implying completeness; recording permission outcomes hub-side is a recorded follow-up, out of scope here",
  );
  assert.ok(markup.includes("the audit relay has not answered yet"), "the unanswered relay is a named absence, never a fabricated ledger");
});

test("the named absence rides the transport's reason when the hub predates the relay", () => {
  const markup = renderToStaticMarkup(createElement(AuditView, { record: { audit: null, reason: "hub unavailable" } }));
  assert.ok(markup.includes("no audit lanes — hub unavailable"), "the page-level absence carries the transport's reason verbatim");
  assert.ok(markup.includes("audit-boundary"), "the boundary still renders beside the absence");
  assert.ok(!markup.includes("audit-lane"), "no lane section implies a populated lane the hub does not keep");
});

test("the three lanes render their records verbatim — kernel/gate kinds, provenance fields, the recorded read", () => {
  const record = auditWith({
    providerReads: { at: freshAt, outcome: "ok" },
    kernelGates: [
      { kind: "transition", actor: "system (run lane)", authority: "run begin (registry)", summary: "nightly sweep: READY → IN_PROGRESS", at: freshAt },
      { kind: "gate", actor: "system", authority: "recorded blocking reason (run registry)", summary: "run schedule:nightly:audit blocked: reviewer not yet run", at: null },
    ],
    reviewProvenance: [{
      version: 1,
      workspace: "/ws",
      fingerprint: {
        commitHash: "0".repeat(40),
        promptDigest: "1".repeat(64),
        diffDigest: "2".repeat(64),
        manifestDigest: "3".repeat(64),
        partitionDigest: "4".repeat(64),
        ruleSetDigest: "5".repeat(64),
      },
      reviewer: "hub-reviewer:test",
      inspectedUnits: ["manifest"],
      coveredPaths: ["src/main.ts"],
      findings: "no blocking findings",
      verification: ["lint exit 0"],
      disposition: "approved",
      recordedAt: "2026-09-30T00:00:00.000Z",
    }],
  });
  const markup = renderToStaticMarkup(createElement(AuditView, { record }));
  assert.ok(markup.includes("audit-lane-provider-reads"), "lane 1 renders");
  assert.ok(markup.includes("audit-lane-kernel-gates"), "lane 2 renders");
  assert.ok(markup.includes("audit-lane-review-provenance"), "lane 3 renders");
  assert.ok(markup.includes("nightly sweep: READY → IN_PROGRESS"), "the kernel row renders its record verbatim");
  assert.ok(markup.includes("blocked: reviewer not yet run"), "the gate row renders its record verbatim");
  assert.ok(markup.includes("hub-reviewer:test"), "the provenance row renders its reviewer verbatim");
  assert.ok(markup.includes("no blocking findings"), "the provenance row renders its findings verbatim");
  assert.ok(markup.includes("approved"), "the provenance row renders its disposition verbatim");
  assert.ok(markup.includes("in-memory only"), "the kernel/gate lane copies the retention statement verbatim");
  assert.ok(markup.includes("board-liveness-fresh"), "the fresh recorded read renders the W167 pill");
  assert.ok(!markup.includes("board-link-not-fresh"), "a fresh read never renders the dashed state");
});

test("the provider-read row's freshness renders as the W167 pills do — dashed when not fresh, no pill without a record", () => {
  const stale = auditWith({ providerReads: { at: staleAt, outcome: "ok" } });
  const staleMarkup = renderToStaticMarkup(createElement(AuditView, { record: stale }));
  assert.ok(staleMarkup.includes("board-liveness-stale"), "the stale read renders the W167 pill class");
  assert.ok(staleMarkup.includes(">stale<"), "the stale pill speaks the shared liveness label");
  assert.ok(staleMarkup.includes("board-link-not-fresh"), "a not-fresh read renders dashed, as the W167 board links do");

  const fault = auditWith({ providerReads: { at: freshAt, outcome: "unreachable", reason: "the provider answered 503" } });
  const faultMarkup = renderToStaticMarkup(createElement(AuditView, { record: fault }));
  assert.ok(faultMarkup.includes("board-liveness-unreachable"), "the fault record renders its outcome verbatim");
  assert.ok(faultMarkup.includes("the provider answered 503"), "the fault's verbatim reason rides the row");

  const none = auditWith({});
  const noneMarkup = renderToStaticMarkup(createElement(AuditView, { record: none }));
  assert.ok(noneMarkup.includes("no provider-read record"), "the empty ledger names its absence");
  assert.ok(!noneMarkup.includes("board-liveness"), "no pill renders without a record (no fabricated freshness)");
});

test("empty lanes name their absence; the unavailable provenance read names its failure", () => {
  const empty = auditWith({});
  const markup = renderToStaticMarkup(createElement(AuditView, { record: empty }));
  assert.ok(markup.includes("no kernel transitions or gate records yet"), "the empty kernel/gate lane names its absence");
  assert.ok(markup.includes("no review provenance recorded yet"), "the empty provenance lane names its absence");
  assert.ok(markup.includes("no provider-read record"), "the empty provider-read lane names its absence");

  const failed = auditWith({ reviewProvenance: null });
  const failedMarkup = renderToStaticMarkup(createElement(AuditView, { record: failed }));
  assert.ok(failedMarkup.includes("review provenance unavailable (the journal read failed closed)"), "a failed journal read is named, never an empty list");

  const predates = auditWith({});
  delete (predates.audit as { reviewProvenance?: unknown }).reviewProvenance;
  const predatesMarkup = renderToStaticMarkup(createElement(AuditView, { record: predates }));
  assert.ok(predatesMarkup.includes("the hub predates the review-provenance lane"), "the absent provenance lane is named as a predating hub");
});