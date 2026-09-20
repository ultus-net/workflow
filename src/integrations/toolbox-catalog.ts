import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mkdirSyncReal = mkdirSync;
const existsSyncReal = existsSync;
const readFileSyncReal = readFileSync;
const writeFileSyncReal = writeFileSync;

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

/**
 * W080 mount half (delivery decision 2026-09-21, file-provisioning framing):
 * the connector set the delivered `workflow-toolbox` skill declares — the
 * hub-critical pair (the guard for policy checks, skills-mcp because it is
 * the delivery path itself), filtered to BUILT entries so the declaration
 * never mounts a connector the vendored corpus cannot serve. Everything else
 * stays operator-settings-driven: the declaration is a floor, not a
 * wholesale mount.
 */
export function declaredSkillConnectors(catalog: readonly ToolboxCatalogEntry[]): readonly string[] {
  return catalog
    .filter((entry) => entry.available && (entry.name === "workflow-guard-mcp" || entry.name === "skills-mcp"))
    .map((entry) => entry.name);
}

export interface SkillConnectorMount {
  readonly name: string;
  readonly serverPath: string;
}

/**
 * W080: the stdio mounts a session composes for the skill's declared
 * connectors — built entries only, minus anything the operator explicitly
 * disabled in settings (an explicit operator disable always wins over a
 * skill declaration; scoping never overrides operator intent) and minus
 * `alreadyMounted` names (skills-mcp itself is mounted by the delivery
 * mount, never twice). The entries ride the same hub-written launch config
 * every mount crosses, so the application/guard authorization applies to
 * them exactly as to any other MCP server.
 */
export function skillConnectorMounts(
  catalog: readonly ToolboxCatalogEntry[],
  options: { disabled?: readonly string[]; alreadyMounted?: readonly string[] } = {},
): readonly SkillConnectorMount[] {
  const disabled = new Set(options.disabled ?? []);
  const mounted = new Set(options.alreadyMounted ?? []);
  return declaredSkillConnectors(catalog)
    .filter((name) => !disabled.has(name) && !mounted.has(name))
    .map((name) => {
      const entry = catalog.find((candidate) => candidate.name === name)!;
      return { name: entry.name, serverPath: entry.serverPath };
    });
}

/**
 * W080 delivery (file-provisioning framing, 2026-09-21): provision the
 * generated `workflow-toolbox` skill into the hub-owned delivery store —
 * `<skillsDir>/workflow-toolbox/SKILL.md`, the directory `skills-mcp` scans.
 * This is NOT native host skill injection: the host's native skill tool stays
 * permission-denied, and the model reaches the content only through the
 * journaled `read_skill` (the F1 single delivery path). Writes only on
 * create or content drift (byte-compare — no churn on every session); the
 * store directory is created when missing. IO is injectable for tests.
 */
export interface ProvisionToolboxSkillIo {
  readonly mkdirSync?: (path: string, options: { recursive: boolean; mode?: number }) => unknown;
  readonly existsSync?: (path: string) => boolean;
  readonly readFileSync?: (path: string) => string;
  readonly writeFileSync?: (path: string, data: string, options: { encoding: "utf8"; mode: number }) => unknown;
}

export function provisionToolboxSkill(
  skillsDir: string,
  catalog: readonly ToolboxCatalogEntry[],
  io: ProvisionToolboxSkillIo = {},
): { readonly skillPath: string; readonly written: boolean } {
  const mkdir = io.mkdirSync ?? ((path: string, options: { recursive: boolean; mode?: number }) => mkdirSyncReal(path, options));
  const exists = io.existsSync ?? existsSyncReal;
  const read = io.readFileSync ?? ((path: string) => readFileSyncReal(path, "utf8"));
  const write = io.writeFileSync ?? ((path: string, data: string, options: { encoding: "utf8"; mode: number }) => writeFileSyncReal(path, data, options));
  const skillDir = join(skillsDir, "workflow-toolbox");
  const skillPath = join(skillDir, "SKILL.md");
  const body = toolboxSkillBody(catalog, { connectors: declaredSkillConnectors(catalog) });
  if (exists(skillPath) && read(skillPath) === body) {
    return { skillPath, written: false };
  }
  mkdir(skillDir, { recursive: true, mode: 0o700 });
  write(skillPath, body, { encoding: "utf8", mode: 0o600 });
  return { skillPath, written: true };
}
