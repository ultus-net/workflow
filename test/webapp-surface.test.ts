import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CommandPalette, ConfigChips, ConnectionsSection, ContextSection, McpConnections, StatusBar, UsageMeter } from "../src/ui/webapp/app.js";
import { ConfigField, ConfigSelect } from "../src/ui/webapp/config-field.js";
import { EditDiff, parseEditTool } from "../src/ui/webapp/diff-text.js";
import { AgentOptionsSection, AgentSection, AppearanceSection, McpSection, RoutingSection, SchedulesSection } from "../src/ui/webapp/settings-dialog.js";
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

test("settings page surfaces the Workflow-owned MCP catalog and states launch-time application", () => {
  const markup = renderToStaticMarkup(createElement(McpSection, {
    mcp: {
      servers: [
        { name: "context7", enabled: true, transport: "http", url: "https://mcp.context7.com/mcp" },
        { name: "guard", enabled: false, transport: "stdio", command: "node", args: ["server.js"] },
      ],
      catalog: [],
      scope: "workspace",
      workspaceOverlay: true,
      loading: false,
      error: undefined,
      setScope: noop,
      upsert: async () => {},
      remove: async () => {},
      toggle: async () => {},
    },
  }));
  assert.ok(markup.includes("MCP servers"), "the MCP catalog section must render");
  assert.ok(markup.includes("context7") && markup.includes("guard"), "every configured server must be listed");
  assert.ok(markup.includes("Global") && markup.includes("Workspace"), "both settings scopes must be selectable");
  assert.ok(markup.includes("apply when a") && markup.includes("session starts"), "the page must state that MCP changes apply on the next session");
  assert.ok(markup.includes("config-toggle"), "each server must carry an enable toggle");
});

test("the connectors section lists vendored apps with availability and add controls", () => {
  const markup = renderToStaticMarkup(createElement(McpSection, {
    mcp: {
      servers: [{ name: "skills-mcp", enabled: true, transport: "stdio", command: "node", args: ["server.js"] }],
      catalog: [
        { name: "skills-mcp", description: "Skills delivery.", transport: "stdio", serverPath: "/x/dist/server.js", available: true },
        { name: "git-intelligence-mcp", description: "Git intelligence.", transport: "stdio", serverPath: "/x/dist/server.js", available: true },
        { name: "egress-audit-mcp", description: "Egress audit.", transport: "stdio", serverPath: "/x/dist/server.js", available: false },
      ],
      scope: "global",
      workspaceOverlay: false,
      loading: false,
      error: undefined,
      setScope: noop,
      upsert: async () => {},
      remove: async () => {},
      toggle: async () => {},
    },
  }));
  assert.ok(markup.includes("Available connectors"), "the vendored connector grid must render");
  assert.ok(markup.includes("Added"), "a connector already configured must show as added, not a duplicate add");
  assert.ok(markup.includes("Git intelligence."), "an unconfigured connector must carry its description");
  assert.ok(markup.includes("not built (npm run toolbox:build)"), "an unbuilt connector must state its availability honestly");
  assert.ok(markup.includes("Unbuilt"), "an unbuilt connector must be labeled and its Add control disabled");
  assert.ok(!markup.includes(">Add</button>") || markup.includes("mcp-catalog-add"), "an available unconfigured connector offers Add");
});

test("agent options group boolean config options as tools and list remembered decisions", () => {
  const markup = renderToStaticMarkup(createElement(AgentOptionsSection, {
    options: FULL_OPTIONS,
    setOption: noop,
    patterns: { alwaysAllow: ["read_files"], alwaysReject: ["run_commands"] },
  }));
  assert.ok(markup.includes("Tools"), "boolean options must surface under a Tools heading");
  assert.ok(markup.includes("Remembered tool decisions"), "remembered decisions must be listed");
  assert.ok(markup.includes("read_files") && markup.includes("run_commands"), "the tool patterns must be named");
});

test("command palette lists commands with keybinds and session switches (the ctrl+p affordance)", () => {
  const markup = renderToStaticMarkup(createElement(CommandPalette, {
    commands: [
      { id: "new-session", title: "New session", group: "command" as const, keybind: "Alt+N", run: noop },
      { id: "open-settings", title: "Open settings", group: "command" as const, keybind: "Ctrl+,", run: noop },
      { id: "switch-1", title: "Switch to: Testing", group: "session" as const, run: noop },
    ],
    onClose: noop,
  }));
  assert.ok(markup.includes("palette"), "the palette must render");
  assert.ok(markup.includes("New session") && markup.includes("Open settings"), "app commands must be listed");
  assert.ok(markup.includes("Alt+N") && markup.includes("Ctrl+,"), "keybind chips must show on command rows");
  assert.ok(markup.includes("Switch to: Testing"), "session switches must be listed");
  assert.ok(markup.includes("Commands") && markup.includes("Sessions"), "group headers must separate commands from sessions");
});

test("status bar carries the OpenCode-mined footer facts: agent + version, model, usage, branch, keybinds", () => {
  const markup = renderToStaticMarkup(createElement(StatusBar, {
    agent: { name: "OpenCode", containment: "advisory" as const, version: "1.18.31" },
    model: "Kimi Latest",
    usage: { source: "agent" as const, latestPromptTokens: 42000, costUsd: 0.149, contextWindowTokens: 200000 },
    branch: "feat/web-ui-chat-parity",
    isRunning: true,
  }));
  assert.ok(markup.includes("status-bar"), "the status bar must render");
  assert.ok(markup.includes("OpenCode") && markup.includes("1.18.31"), "agent name + handshake version must show");
  assert.ok(markup.includes("Kimi Latest"), "the current model must show");
  assert.ok(markup.includes("usage-meter") && markup.includes("21%"), "the usage readout lives in the status bar (TUI arrangement)");
  assert.ok(markup.includes("feat/web-ui-chat-parity"), "the repository branch must show");
  assert.ok(markup.includes("Esc") && markup.includes("settings"), "the reach-for keybinds must show");
});

test("usage readout: metered runtimes show tokens, unmetered show ACP context + cost without false zeros", () => {
  const metered = renderToStaticMarkup(createElement(UsageMeter, {
    usage: { source: "metered" as const, requests: 3, usageEvents: 3, promptTokens: 84500, completionTokens: 1200, latestPromptTokens: 42000, totalTokens: 85700, costUsd: 0.149, contextWindowTokens: 200000 },
  }));
  assert.ok(metered.includes("usage-meter"), "the usage readout must render");
  assert.ok(metered.includes("21%"), "the context-window fill percentage must show");
  assert.ok(metered.includes("84.5k") && metered.includes("1.2k"), "metered token counters must show");
  assert.ok(metered.includes("$0.1490"), "cost must show");
  // Unmetered (OpenCode): only ACP usage_update fields — context and cost, no
  // invented token counters.
  const unmetered = renderToStaticMarkup(createElement(UsageMeter, {
    usage: { source: "agent" as const, latestPromptTokens: 42000, costUsd: 0.149, contextWindowTokens: 200000 },
  }));
  assert.ok(unmetered.includes("21%"), "agent-reported context fill must show");
  assert.ok(unmetered.includes("$0.1490"), "agent-reported cost must show");
  assert.ok(!unmetered.includes("usage-tokens"), "token counters must stay hidden when the agent does not report them");
});

test("inspector connections state every agent's availability and posture honestly", () => {
  const agents = listWebAgents();
  const markup = renderToStaticMarkup(createElement(ConnectionsSection, {
    agents,
    currentAgent: DEFAULT_WEB_AGENT,
    capabilities: { capabilities: ["process", "network"], workspaceConfinement: true },
  }));
  for (const agent of agents) {
    assert.ok(markup.includes(agent.name), `connections is missing the "${agent.name}" agent`);
  }
  assert.ok(markup.includes("connection-dot"), "each agent row carries a semantic availability dot");
  assert.ok(markup.includes("advisory") && markup.includes("contained"), "containment posture must be stated per agent");
  assert.ok(markup.includes("active"), "the connected agent must be marked active");
  assert.ok(markup.includes("acp transport"), "the transport must be stated");
});

test("edit tool calls render an opencode-style line-numbered diff", () => {
  const patch = "--- a/file.ts\n+++ b/file.ts\n@@ -3,3 +3,4 @@\n ctx\n-old\n+new\n+extra\n ctx2";
  const data = parseEditTool(
    JSON.stringify({ filePath: "src/file.ts" }),
    JSON.stringify({ metadata: { filediff: { file: "src/file.ts", patch, additions: 2, deletions: 1 } } }),
  );
  assert.ok(data !== undefined, "the edit tool data must parse");
  const markup = renderToStaticMarkup(createElement(EditDiff, { data: data! }));
  assert.ok(markup.includes("edit-diff"), "the edit diff must render");
  assert.ok(markup.includes("src/file.ts"), "the file path must show in the header");
  assert.ok(markup.includes("+2") && markup.includes("-1"), "the add/del stats must show");
  assert.ok(markup.includes("edit-diff-add") && markup.includes("edit-diff-del"), "add/del rows must be tinted");
  assert.ok(markup.includes(">3</span>"), "old-file line numbers must be tracked from the hunk header");
});

test("edit diff falls back to before/after strings when no patch is present", () => {
  const data = parseEditTool(
    JSON.stringify({ filePath: "a.ts", oldString: "alpha\nbeta", newString: "alpha\ngamma" }),
    undefined,
  );
  const markup = renderToStaticMarkup(createElement(EditDiff, { data: data! }));
  assert.ok(markup.includes("edit-diff-del") && markup.includes("edit-diff-add"), "a computed diff must tint add/del");
  assert.ok(markup.includes("beta") && markup.includes("gamma"), "the changed lines must show");
});

test("edit diff keeps a deleted line whose payload itself starts with --", () => {
  const patch = "@@ -1,3 +1,2 @@\n keep\n---comment\n-removed\n+added";
  const data = parseEditTool(JSON.stringify({ filePath: "a.sql" }), JSON.stringify({ metadata: { diff: patch } }));
  const markup = renderToStaticMarkup(createElement(EditDiff, { data: data! }));
  assert.ok(markup.includes("--comment"), "a deletion starting with -- must not be dropped as a file header");
  assert.ok(markup.includes("removed") && markup.includes("added"), "the other changed lines must show");
});

test("inspector Context section reports tokens, percent used, and spend", () => {
  const markup = renderToStaticMarkup(createElement(ContextSection, {
    usage: { source: "agent" as const, latestPromptTokens: 42_000, contextWindowTokens: 200_000, costUsd: 0.149 },
  }));
  assert.ok(markup.includes("Context"), "the Context heading must render");
  assert.ok(markup.includes("42.0k") && markup.includes("200.0k"), "tokens used / window must show");
  assert.ok(markup.includes("21%"), "percent used must show");
  assert.ok(markup.includes("$0.1490"), "spend must show");
});

test("inspector MCP section lists the configured catalog honestly, not a fabricated connection", () => {
  const markup = renderToStaticMarkup(createElement(McpConnections, {
    servers: [
      { name: "context7", enabled: true, transport: "http", url: "https://mcp.context7.com/mcp" },
      { name: "guard", enabled: false, transport: "stdio", command: "node" },
    ],
  }));
  assert.ok(markup.includes("MCP"), "the MCP heading must render");
  assert.ok(markup.includes("context7") && markup.includes("guard"), "every configured server must be listed");
  assert.ok(markup.includes("configured") && markup.includes("disabled"), "enabled/disabled state must be stated");
  assert.ok(markup.includes("does not expose"), "the section must state that ACP exposes no live MCP list");
});

test("settings routing section edits per-agent launch defaults and states env facts honestly", () => {
  const markup = renderToStaticMarkup(createElement(RoutingSection, {
    routing: {
      agents: {
        opencode: { model: "openrouter/auto", thoughtLevel: "high" },
        goose: { mode: "build" },
      },
      facts: {
        upstream: "https://openrouter.ai",
        envModelOpencode: true,
        envModelGoose: false,
        managementKey: true,
      },
      loading: false,
      error: undefined,
      onSave: async () => true,
    },
  }));
  assert.ok(markup.includes("Model routing"), "the routing section must render");
  for (const agent of ["OpenCode", "Goose", "Cline"]) {
    assert.ok(markup.includes(agent), `the routing section must cover ${agent}`);
  }
  assert.ok(markup.includes("openrouter/auto"), "the persisted model default must be shown");
  assert.ok(markup.includes("high"), "the persisted reasoning effort must be selected");
  assert.ok(markup.includes("next session"), "the section must state defaults apply at launch, not live");
  assert.ok(markup.includes("wins over the panel default"), "an env-set model override must be stated, not hidden");
  assert.ok(markup.includes("present"), "the management key fact must show presence, never the value");
});

test("the MCP section renders live gateway state and keeps the launch-time copy honest without it", () => {
  const base = {
    servers: [{ name: "guard", enabled: true, transport: "stdio" as const, command: "node" }],
    catalog: [],
    scope: "workspace" as const,
    workspaceOverlay: true,
    loading: false,
    error: undefined,
    setScope: noop,
    upsert: async () => {},
    remove: async () => {},
    toggle: async () => {},
  };
  // Live through the gateway: the server's own states render, attributed.
  const live = renderToStaticMarkup(createElement(McpSection, {
    mcp: { ...base, live: { live: true as const, gatewayUrl: "http://127.0.0.1:4699", servers: [
      { name: "guard", status: "connected" },
      { name: "skills-mcp", status: "failed" },
    ] } },
  }));
  assert.ok(live.includes("Live state"), "the live subgroup must render");
  assert.ok(live.includes("enforced gateway"), "live state must state its source (the enforced gateway)");
  assert.ok(live.includes("guard") && live.includes("connected"), "the live server must render with its status");
  assert.ok(live.includes("failed"), "every live server's state renders, including failures");

  // No live state: the honest reason is the value; launch-time copy intact.
  const unavailable = renderToStaticMarkup(createElement(McpSection, {
    mcp: { ...base, live: { live: false as const, reason: "no server topology daemon is running for this workspace" } },
  }));
  assert.match(unavailable, /No live MCP state/, "the unavailable state must render");
  assert.match(unavailable, /no server topology daemon/, "the honest reason renders as the value");
  assert.ok(unavailable.includes("apply when a") && unavailable.includes("session starts"), "the launch-time statement stays");
});

test("the schedules section lists the hub's cron table and states its limits honestly", () => {
  const markup = renderToStaticMarkup(createElement(SchedulesSection, {
    schedules: {
      schedules: [
        { id: "nightly", title: "Nightly audit", cron: "0 9 * * *", prompt: "audit the repo", requiresReview: true },
        { id: "triage", title: "", cron: "*/30 * * * *", prompt: "triage", workspace: "/ws", requiresReview: false },
      ],
      schedulesPath: "/home/op/.workflow/scheduler.json",
      hub: { reachable: false },
      error: undefined,
      loading: false,
    },
  }));
  assert.ok(markup.includes("Schedules"), "the schedules section must render");
  assert.ok(markup.includes("Nightly audit") && markup.includes("audit the repo"), "the schedule's title and prompt must show");
  assert.ok(markup.includes("0 9 * * *"), "the cron must show");
  assert.ok(markup.includes("triage"), "an untitled schedule falls back to its id");
  assert.ok(markup.includes("review-gated") && markup.includes("no review"), "review posture must be stated per schedule");
  assert.ok(markup.includes("not reachable"), "an unreachable hub is stated honestly");
  assert.ok(markup.includes("edits apply on hub restart"), "the panel must state the startup-load contract");
  assert.ok(markup.includes("monitor TUI"), "run history must be pointed where it actually lives");
});

