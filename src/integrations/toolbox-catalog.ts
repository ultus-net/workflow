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
 * W080 (schema half — the mount half stays gated): the generated skill's
 * frontmatter may declare the connectors a session loading the skill needs
 * mounted. Validation is against the toolbox catalog, fail-loud — an unknown
 * name is a typo or a drift from the vendored corpus, never a silent no-op;
 * duplicates fail too (a duplicated name is a declaration bug, not a
 * repetition request).
 *
 * Delivery is NOT implemented here: per the 2026-09-15 hub-owned-enforcement
 * plan, native host skill injection stays off until its own dated decision
 * (the W080 gate). When delivery ships, it must mount ONLY the declared
 * connectors, through the existing launch-config path (the same
 * hub-written-config composition every mount crosses), with the guard still
 * owning authorization — scoping, never a bypass lane — and any per-host
 * support claim stays probe-gated (the skills-delivery probe family,
 * `WORKFLOW_ACP_OPENCODE_SKILLS`, is pending in `docs/PROBE_VERDICTS.json`).
 */
export function validateSkillConnectors(
  declaration: unknown,
  catalog: readonly ToolboxApp[] = TOOLBOX_CATALOG,
): readonly string[] {
  if (declaration === undefined) return [];
  if (!Array.isArray(declaration)) {
    throw new TypeError("skill connectors declaration must be an array of toolbox catalog names");
  }
  const known = new Set(catalog.map((entry) => entry.name));
  const seen = new Set<string>();
  return declaration.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError("skill connectors declaration entries must be non-empty strings");
    }
    const name = entry.trim();
    if (!known.has(name)) {
      throw new TypeError(`unknown connector in skill declaration: '${name}' — declarations are validated against the toolbox catalog`);
    }
    if (seen.has(name)) {
      throw new TypeError(`duplicate connector in skill declaration: '${name}'`);
    }
    seen.add(name);
    return name;
  });
}

/**
 * W075: the on-demand skill body, GENERATED from the toolbox catalog — the
 * catalog manifest is the single source of truth, so the skill cannot drift
 * from what the hub actually ships. This builds the text only; delivery to
 * host skill directories is a separately dated decision (the 2026-09-15
 * hub-owned-enforcement plan keeps native host skill injection off).
 *
 * W080: an optional `connectors` declaration (validated against the catalog,
 * fail-loud — see `validateSkillConnectors`) is rendered into the frontmatter
 * as the machine-usable list a delivery layer would mount. Omitted means no
 * connector claims and the document stays byte-identical to the W077 corpus
 * pin; declared connectors bump the frontmatter `version` to 2 (the document
 * shape changes).
 */
export function toolboxSkillBody(catalog: readonly ToolboxCatalogEntry[], options: { connectors?: readonly string[] } = {}): string {
  const connectors = validateSkillConnectors(options.connectors, catalog);
  const entries = catalog
    .map((entry) => `- **${entry.name}** — ${entry.description} (${entry.available ? "available" : "unbuilt"})`)
    .join("\n");
  return [
    "---",
    'name: workflow-toolbox',
    'description: The Workflow hub toolbox — every MCP server the hub can mount, what each is for, and current build state. Load before using hub tools.',
    connectors.length > 0 ? "version: 2" : "version: 1",
    ...(connectors.length > 0 ? ["connectors:", ...connectors.map((name) => `  - ${name}`)] : []),
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
