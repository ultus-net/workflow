import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusBar } from "../src/ui/webapp/app.js";

/**
 * W204 — the status bar must not paint over itself at narrow widths.
 *
 * Measured over the repo's CDP harness at 1728..1024: the nowrap usage meter
 * (context fill, cost) kept its full intrinsic width while the keybind strip
 * was pushed left, so from ~1281px down the meter's text painted across the
 * hints (`3d9k / 2 Ctrl ⌘0..1132 Ctrl + K palette`). Below 900px the middle
 * group collapsed to 0 width while its content still painted.
 *
 * The fix is CSS: the meter clips its own overflow (`min-width: 0;
 * overflow: hidden`), and below the measured collision onset the keybind strip
 * yields (it is duplicated in the composer hint line). These pins assert the
 * rule text; the visual proof lives in the ledger's CDP measurements.
 */

const css = readFileSync(resolve("src/ui/webapp/styles.css"), "utf8");

test("W204: the status-bar usage meter clips its own overflow", () => {
  const rule = /\.status-bar \.usage-meter\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule !== null, "the status-bar usage-meter rule exists");
  const body = rule[1] ?? "";
  assert.match(body, /min-width:\s*0/, "the meter can shrink below its content width");
  assert.match(body, /overflow:\s*hidden/, "the meter clips its nowrap text instead of painting over neighbors");
});

test("W204: below the measured onset the keybind strip yields to the live meter", () => {
  // The strip is duplicated in the composer hint line, so it is the safe yield.
  assert.match(
    css,
    /@media \(max-width: 1280px\)\s*\{[^@]*\.status-bar-keys\s*\{\s*display:\s*none/,
    "the 1280px breakpoint hides the keybind strip",
  );
  // The meter must NOT be the thing hidden: it is the live operator signal.
  assert.ok(
    !/@media \(max-width: 1280px\)\s*\{[^@]*\.status-bar \.usage-meter\s*\{\s*display:\s*none/.test(css),
    "the live usage meter is never hidden at the yield breakpoint",
  );
});

test("W204: the meter and the keybinds ride distinct status-bar groups", () => {
  const markup = renderToStaticMarkup(createElement(StatusBar, {
    agent: { name: "OpenCode", containment: "advisory" as const, version: "1.18.31" },
    model: "Kimi Latest",
    usage: { source: "agent" as const, latestPromptTokens: 42000, costUsd: 0.149, contextWindowTokens: 200000 },
    branch: "feat/web-ui-chat-parity",
    isRunning: true,
  }));
  assert.ok(markup.includes("status-bar-middle") && markup.includes("usage-meter"), "the meter rides the middle group");
  assert.ok(markup.includes("status-bar-keys"), "the keybind strip renders");
  assert.ok(markup.indexOf("usage-meter") < markup.indexOf("status-bar-keys"), "they stay separate clusters, meter before keys");
});
