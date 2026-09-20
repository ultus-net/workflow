import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The vendored connector catalog: every MCP server shipped under
 * `mcp-toolbox/apps`, surfaced to the operator settings panel so connectors
 * are one-toggle enable rather than hand-typed JSON.
 *
 * The list is a static manifest on purpose — the apps are vendored and only
 * change via reviewed PR — and `test/toolbox-catalog.test.ts` executes the
 * manifest against the real `mcp-toolbox/apps` tree (names, descriptions,
 * built entrypoints) so it cannot silently drift from the corpus, matching
 * the toolbox-corpus-stays-executable discipline.
 */

export interface ToolboxApp {
  readonly name: string;
  readonly description: string;
}

export const TOOLBOX_CATALOG: readonly ToolboxApp[] = [
  { name: "workflow-guard-mcp", description: "Cross-client MCP policy checks for safer agentic coding workflows." },
  { name: "workflow-fs-exec-mcp", description: "Hub-implemented contained fs/exec server for agents that delegate operations to the client (ACP `--pure`)." },
  { name: "skills-mcp", description: "Hub-owned skills delivery over MCP: metadata-only discovery plus on-demand content (plan Task F1)." },
  { name: "project-context-mcp", description: "Bounded read-only repository task and planning context discovery over MCP." },
  { name: "project-memory-mcp", description: "Bounded durable project memory for coding agents over MCP." },
  { name: "git-intelligence-mcp", description: "Structured local Git change and history intelligence for coding agents over MCP." },
  { name: "code-intelligence-mcp", description: "Structured semantic code navigation for coding agents over MCP." },
  { name: "test-intelligence-mcp", description: "Structured test discovery and execution for coding agents over MCP." },
  { name: "ci-intelligence-mcp", description: "Bounded read-only CI run and job intelligence for coding agents over MCP." },
  { name: "change-intelligence-mcp", description: "Composed local change assessment for coding agents over MCP." },
  { name: "browser-verification-mcp", description: "Bounded, evidence-producing browser verification over CDP for coding agents." },
  { name: "verification-accountability-mcp", description: "Durable bounded verification observations and freshness synthesis over MCP." },
  { name: "review-accountability-mcp", description: "Subject-bound review attestations and durable follow-up debt over MCP." },
  { name: "continuity-checkpoint-mcp", description: "Bounded read-only continuity recovery for coding agents over MCP." },
  { name: "egress-audit-mcp", description: "Append-only, bounded egress-reach ledger with anomaly flags for coding agents over MCP." },
  { name: "learning-mcp", description: "Adaptive pedagogy engine (learner profile, stage progression, intervention budgeting, Socratic checkpoints) over MCP." },
];

/** Package root: two levels up from this module (src|dist/integrations → root). */
export function packageRoot(importUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(importUrl)), "..", "..");
}

/** The vendored stdio entrypoint for one catalog app. */
export function toolboxServerPath(root: string, name: string): string {
  return resolve(root, "mcp-toolbox", "apps", name, "dist", "server.js");
}

export interface ToolboxCatalogEntry extends ToolboxApp {
  readonly transport: "stdio";
  /** Absolute vendored entrypoint (command: node, args: [serverPath]). */
  readonly serverPath: string;
  /** `dist/server.js` is built and present. */
  readonly available: boolean;
}

/**
 * Resolves the catalog against a toolbox root. IO is injectable so callers
 * (and tests) can probe availability without touching the filesystem.
 */
export function resolveToolboxCatalog(options: {
  root?: string;
  exists?: (path: string) => boolean;
} = {}): readonly ToolboxCatalogEntry[] {
  const root = options.root ?? packageRoot();
  const exists = options.exists ?? ((path: string) => existsSync(path));
  return TOOLBOX_CATALOG.map((app) => {
    const serverPath = toolboxServerPath(root, app.name);
    return { ...app, transport: "stdio" as const, serverPath, available: exists(serverPath) };
  });
}

/**
 * W075: the on-demand skill body, GENERATED from the toolbox catalog — the
 * catalog manifest is the single source of truth, so the skill cannot drift
 * from what the hub actually ships. This builds the text only; delivery to
 * host skill directories is a separately dated decision (the 2026-09-15
 * hub-owned-enforcement plan keeps native host skill injection off).
 */
export function toolboxSkillBody(catalog: readonly ToolboxCatalogEntry[]): string {
  const entries = catalog
    .map((entry) => `- **${entry.name}** — ${entry.description} (${entry.available ? "available" : "unbuilt"})`)
    .join("\n");
  return [
    "---",
    'name: workflow-toolbox',
    'description: The Workflow hub toolbox — every MCP server the hub can mount, what each is for, and current build state. Load before using hub tools.',
    'version: 1',
    "---",
    "",
    "# Workflow toolbox",
    "",
    "These MCP servers compose the Workflow hub's toolbox. Availability reflects the",
    "vendored build; the hub's route-class gateway and the guard MCP server own the",
    "enforcement — this document orients, it never authorizes.",
    "",
    "## Connectors",
    "",
    entries,
    "",
  ].join("\n");
}
