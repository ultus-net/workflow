import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConfigChips } from "../src/ui/webapp/app.js";
import { ConfigField, ConfigSelect } from "../src/ui/webapp/config-field.js";
import { AgentOptionsSection, AgentSection, AppearanceSection } from "../src/ui/webapp/settings-dialog.js";
import { listPalettes } from "../src/ui/webapp/theme/palettes.js";
import { DEFAULT_WEB_AGENT, listWebAgents } from "../src/ui/web-agents.js";
import type { WebConfigOption } from "../src/ui/web-config-options.js";

// UI-surface regression pin. Other PRs have merged changes that silently
// removed frontend surface (options, chips, the agent switcher, the square
// edges). These tests pin what is on the UI *today* so any PR that removes or
// alters it fails loudly here instead of reverting the operator's battlestation.

const noop = (): void => {};

// A representative full ACP option set (mirrors the live surface: provider,
// model, effort, mode selects plus boolean tool toggles).
const MANY_MODELS = Array.from({ length: 297 }, (_, index) => ({ value: `m${index}`, name: `Model ${index}` }));
const FULL_OPTIONS: readonly WebConfigOption[] = [
  { id: "provider", name: "Provider", category: "provider", type: "select", currentValue: "openrouter", choices: [{ value: "openrouter", name: "OpenRouter" }, { value: "azure", name: "Azure" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "m0", choices: MANY_MODELS },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", choices: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "code", choices: [{ value: "code", name: "Act" }, { value: "ask", name: "Ask" }] },
  { id: "web_search", name: "Web search", type: "boolean", currentValue: true },
  { id: "auto_approve", name: "Auto approve", type: "boolean", currentValue: false },
];

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

test("settings menu surfaces every advertised ACP option (operator preference #2)", () => {
  const markup = renderToStaticMarkup(createElement(AgentOptionsSection, { options: FULL_OPTIONS, setOption: noop }));
  for (const option of FULL_OPTIONS) {
    assert.ok(markup.includes(option.name), `settings is missing the "${option.name}" option — nothing may be removed from the canonical set`);
  }
  // Booleans render as toggles, selects as fields — both control kinds present.
  assert.ok(count(markup, "config-toggle") >= 2, "boolean options must render as toggles");
});

test("agent switcher lists every registered agent with the documented default first", () => {
  const agents = listWebAgents();
  const markup = renderToStaticMarkup(createElement(AgentSection, { agents, currentAgent: DEFAULT_WEB_AGENT, onSwitchAgent: noop }));
  assert.equal(agents[0]?.id, "opencode", "OpenCode is the documented default/lead agent");
  for (const agent of agents) {
    assert.ok(markup.includes(agent.name), `switcher is missing the "${agent.name}" agent`);
  }
  assert.ok(markup.includes("OpenCode") && markup.includes("Cline"), "both agents must stay reachable");
  // The default agent is marked current; the two postures are stated honestly.
  assert.ok(markup.includes("agent-row-current"), "the active agent must be marked current");
  assert.ok(markup.includes("advisory") && markup.includes("contained"), "containment posture must be stated per agent");
});

test("composer chips render every select option and no boolean toggles", () => {
  const markup = renderToStaticMarkup(createElement(ConfigChips, { options: FULL_OPTIONS, setOption: noop }));
  const selects = FULL_OPTIONS.filter((option) => option.type === "select");
  const chipCount = count(markup, "config-picker");
  assert.equal(chipCount, selects.length, `every select option must surface as a composer chip (${selects.length} expected)`);
  for (const option of selects) {
    assert.ok(markup.includes(`config-list-${option.id}`) || markup.includes(option.name) || markup.includes(option.id), `composer is missing the "${option.name}" chip`);
  }
});

test("the full model list renders — no truncation of the advertised choices", () => {
  // Short-list path: a native select renders every choice as an <option>.
  const selectMarkup = renderToStaticMarkup(createElement(ConfigSelect, { option: FULL_OPTIONS[1]!, setOption: noop }));
  assert.equal(count(selectMarkup, "<option"), MANY_MODELS.length, "every advertised model must render — the full OpenRouter list, not a stub");
});

test("long option lists route to the searchable combobox, short lists to a select", () => {
  const longMarkup = renderToStaticMarkup(createElement(ConfigField, { option: FULL_OPTIONS[1]!, setOption: noop }));
  assert.ok(longMarkup.includes("config-combobox-button"), "a 297-choice model must use the searchable combobox");
  const shortOption: WebConfigOption = { id: "mode", name: "Mode", type: "select", currentValue: "code", choices: [{ value: "code", name: "Act" }, { value: "ask", name: "Ask" }] };
  const shortMarkup = renderToStaticMarkup(createElement(ConfigField, { option: shortOption, setOption: noop }));
  assert.ok(shortMarkup.includes("<select"), "a short list keeps the native select");
});

test("sharp square edges: no nonzero border-radius survives in the design system", () => {
  const css = readFileSync(resolve("src/ui/webapp/styles.css"), "utf8");
  // The corner tokens are the single source of truth and must be square.
  assert.match(css, /--radius:\s*0\b/, "--radius token must be 0 (brutal square edges)");
  assert.match(css, /--radius-s:\s*0\b/, "--radius-s token must be 0");
  // No hardcoded nonzero radius may creep back in (rounded corners, pills,
  // circles). Check every token of every declaration: each must be a literal
  // zero (any unit, e.g. `0`, `0px`, `0.0rem`) or a var() reference. `0px` is
  // allowed; `0.5px`/`10px`/`50%`/`999px` are flagged — robust unlike a regex.
  const zeroToken = /^0(\.0+)?[a-z%]*$/;
  const isSquare = (value: string): boolean => value.split(/\s+/).every((token) => token.startsWith("var(") || zeroToken.test(token));
  const declarations = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1]?.trim() ?? "");
  const offenders = declarations.filter((value) => !isSquare(value));
  assert.deepEqual(offenders, [], `nonzero border-radius reintroduced: ${offenders.join(", ")}`);
});

test("the settings Appearance section exposes the full palette catalog plus the amber default", () => {
  const palettes = listPalettes();
  const markup = renderToStaticMarkup(createElement(AppearanceSection, {
    themeChoice: "system",
    onThemeChoice: noop,
    palette: undefined,
    onPalette: noop,
    palettes,
    railsOff: false,
    onRailsToggle: noop,
  }));
  assert.ok(markup.includes("Workflow amber"), "the default identity must be selectable");
  const unescaped = markup.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  for (const entry of palettes) {
    assert.ok(unescaped.includes(entry.name), `palette picker is missing "${entry.name}" (${entry.id})`);
  }
  assert.ok(markup.includes('class="palette-swatch"'), "every palette chip must carry a swatch preview");
  assert.equal(count(markup, 'role="option"'), palettes.length + 1, "one chip per catalog theme plus the amber default");
});
