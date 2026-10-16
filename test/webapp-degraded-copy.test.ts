import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PostureStrip } from "../src/ui/webapp/posture-strip.js";
import { RoutesView } from "../src/ui/webapp/routes-view.js";
import { UsageAttributionNote, UsageUnavailable, type UsagePayload } from "../src/ui/webapp/usage-view.js";

/**
 * W203 — the hub degraded/empty copy pass (rule R4 of
 * `docs/HUB_LAYOUT_IA_REWORK.md`, continued). W201 fixed the Board and Agents
 * degraded copy; this wave finishes the class: a server string (an env-var
 * instruction) is never page content, a run-on attribution note becomes a lead
 * plus a disclosure, and a degraded strip states its reason once, not twice.
 *
 * Every pin is red-first against `27ba5e44`: the Usage setup rendered the raw
 * server reason, the attribution was one `<p>`, and the posture strip read
 * "hub unavailable (hub unavailable)".
 */

const noop = (): void => {};

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

/** The first paragraph element's inner text — the "page lead" these pins judge. */
function leadParagraph(markup: string): string {
  const start = markup.indexOf("<p");
  const end = markup.indexOf("</p>", start);
  return start === -1 || end === -1 ? "" : markup.slice(start, end);
}

const USAGE_REASON = "OpenRouter analytics need a Management key — set WORKFLOW_OPENROUTER_MANAGEMENT_KEY (server-side only; it never reaches the browser)";

function usagePayload(overrides: Partial<UsagePayload> = {}): UsagePayload {
  return { available: false, reason: USAGE_REASON, ...overrides };
}

test("W203: the Usage degraded state leads with operator copy, never the raw env-var string", () => {
  const markup = renderToStaticMarkup(createElement(UsageUnavailable, { payload: usagePayload() }));
  const lead = leadParagraph(markup);
  assert.ok(!lead.includes("WORKFLOW_OPENROUTER_MANAGEMENT_KEY"), "the env-var instruction is not the page lead");
  assert.match(lead, /analytics are not configured/i, "the lead is operator copy");
  // The fix (the variable name) survives, demoted into a disclosure.
  assert.ok(markup.includes("<details"), "the setup guidance rides a disclosure");
  assert.ok(markup.includes("WORKFLOW_OPENROUTER_MANAGEMENT_KEY"), "the variable that fixes it stays reachable");
  const detailsIdx = markup.indexOf("<details");
  assert.ok(detailsIdx < markup.indexOf("WORKFLOW_OPENROUTER_MANAGEMENT_KEY"), "the variable reads inside the disclosure, not before it");
});

test("W203: a transport-failure Usage degrade states the error plainly (no analytics lecture)", () => {
  const markup = renderToStaticMarkup(createElement(UsageUnavailable, { payload: { available: false, error: "usage unavailable (network error)" } }));
  assert.ok(markup.includes("usage unavailable (network error)"), "the transport error renders verbatim");
  assert.ok(!markup.includes("analytics are not configured"), "a transport failure is not labeled a missing key");
});

test("W203: the Usage attribution note becomes a lead plus a disclosure list of uncovered lanes", () => {
  const markup = renderToStaticMarkup(createElement(UsageAttributionNote, {
    attribution: {
      perTask: "not yet built — turn-boundary attribution is queued",
      unrecordedLanes: ["hub reviewer-lane spend is recorded nowhere", "RSI proposal turns are recorded nowhere"],
      attention: "unmeasured",
    },
  }));
  assert.ok(markup.includes("<details"), "the lanes ride a disclosure, not a run-on paragraph");
  assert.equal(count(markup, "<li"), 2, "each uncovered lane is its own list item");
  assert.ok(markup.includes("reviewer-lane") && markup.includes("RSI proposal"), "the lane text is rendered verbatim");
  // The lead keeps the per-task fact but is no longer the wall of text.
  assert.match(leadParagraph(markup), /per-task attribution/, "the lead states the per-task fact");
});

test("W203: the posture strip states its reason once (no 'hub unavailable (hub unavailable)')", () => {
  const markup = renderToStaticMarkup(createElement(PostureStrip, { state: { posture: null, reason: "hub unavailable" }, onAction: noop }));
  assert.equal(count(markup, "hub unavailable"), 1, "the reason is not echoed");
  assert.match(markup, /operator posture/, "the strip still labels itself");
});

test("W203: a non-'hub unavailable' degraded reason still renders exactly once", () => {
  const markup = renderToStaticMarkup(createElement(PostureStrip, { state: { posture: null, reason: "connection refused" }, onAction: noop }));
  assert.equal(count(markup, "connection refused"), 1, "the transport reason renders once");
});

test("W203: the Routes empty state demotes the env-var instruction into a disclosure", () => {
  const markup = renderToStaticMarkup(createElement(RoutesView, { routes: [] }));
  assert.ok(markup.includes("No routes are configured for this hub."), "the operator lead renders");
  const detailsIdx = markup.indexOf("<details");
  const envIdx = markup.indexOf("WORKFLOW_ASSISTANT_ROUTES");
  assert.ok(detailsIdx !== -1, "the setup guidance rides a disclosure");
  assert.ok(envIdx !== -1, "the variable that fixes it stays reachable");
  assert.ok(envIdx > detailsIdx, "the env var reads inside the disclosure, not as page content");
});

test("W203: the page-header subtitle resets the empty-state box (CSS pin)", () => {
  const css = readFileSync(resolve("src/ui/webapp/styles.css"), "utf8");
  const ruleMatch = /\.sessions-view-head\s*>\s*\.sessions-empty-note\s*\{([^}]*)\}/.exec(css);
  assert.ok(ruleMatch !== null, "the header-subtitle rule exists");
  const body = ruleMatch[1] ?? "";
  assert.match(body, /flex-basis:\s*100%/, "the subtitle wraps to its own full-width row");
  assert.match(body, /border:\s*0/, "the empty-state border is reset");
  assert.match(body, /background:\s*none/, "the empty-state fill is reset");
});
