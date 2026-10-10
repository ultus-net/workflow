import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * W086 — the control-plane fleet payload: the OpenCode agent/command files
 * and the companion repo docs the fleet references, vendored into this
 * repository under `assets/opencode-fleet/` with a committed sha256 manifest
 * (regenerate via `node scripts/generate-fleet-manifest.mjs`).
 *
 * Trust boundary, stated precisely (the guard-policy tier model,
 * 2026-09-21): the vendored assets are versioned source — PR review carries
 * their audit. `installFleet` writes ONLY into the operator-invoked targets
 * (the host agent/command directories and, install-if-missing only, the
 * workspace's docs/agents files). It never touches the root host config
 * document — that file is the permission surface and stays operator-owned;
 * the doctor verifies it and prints the fragment, the installer never
 * rewrites it. Nothing here runs unattended: running `workflow install
 * fleet` is the operator's ask-gate.
 *
 * The docs bundle is install-if-missing by design: `lessons.md` is a
 * per-repo append-only memory and the other docs are repo-owned living
 * documents — the installer never overwrites any of them, with or without
 * force. Drift is the doctor's job to surface, not the installer's to
 * destroy.
 */

export type FleetKind = "agent" | "command" | "doc";

export interface FleetEntry {
  readonly id: string;
  readonly kind: FleetKind;
  readonly file: string;
  readonly sha256: string;
}

export interface FleetManifest {
  readonly version: number;
  readonly entries: readonly FleetEntry[];
}

export type FleetEntryState = "current" | "missing" | "differs";

export interface FleetStatus {
  readonly entry: FleetEntry;
  readonly target: string;
  readonly state: FleetEntryState;
}

export type FleetInstallAction = "written" | "already-current" | "skipped-local-modified" | "skipped-repo-doc" | "forced";

export interface FleetInstallResult {
  readonly entry: FleetEntry;
  readonly target: string;
  readonly action: FleetInstallAction;
}

export interface FleetOptions {
  /** Package/checkout root holding `assets/opencode-fleet` (defaults to this module's package). */
  readonly root?: string;
  /** Operator home (defaults to the process home); hosts the agent/command config dirs. */
  readonly home?: string;
  /** Host agent-config directory override (tests; defaults to `<home>/.config/opencode`). */
  readonly configDir?: string;
  /** Workspace whose repo docs receive the docs bundle (defaults to cwd). */
  readonly workspace?: string;
  /**
   * Restrict install/compare to these kinds (default: every kind). The plane
   * runtime installs only the agent/command config surface into its hub-owned
   * config dir and never the workspace docs, so it passes `["agent", "command"]`.
   */
  readonly kinds?: readonly FleetKind[];
}

/** Manifest entries narrowed to the requested kinds (all kinds when absent). */
function selectedEntries(manifest: FleetManifest, kinds: readonly FleetKind[] | undefined): readonly FleetEntry[] {
  return kinds === undefined ? manifest.entries : manifest.entries.filter((entry) => kinds.includes(entry.kind));
}

const KINDS: readonly FleetKind[] = ["agent", "command", "doc"];

/** Vendored assets directory: an explicit root wins; otherwise this package's own checkout/install. */
export function fleetAssetsRoot(options: Pick<FleetOptions, "root"> = {}): string {
  if (options.root !== undefined) return join(options.root, "assets", "opencode-fleet");
  return fileURLToPath(new URL("../../assets/opencode-fleet/", import.meta.url));
}

/** Where an entry installs: agents/commands under the host config dir, docs under the workspace repo. */
export function fleetTarget(entry: FleetEntry, options: Pick<FleetOptions, "home" | "workspace" | "configDir"> = {}): string {
  const configDir = options.configDir ?? join(options.home ?? homedir(), ".config", "opencode");
  if (entry.kind === "doc") {
    return join(options.workspace ?? process.cwd(), "docs", "agents", entry.file);
  }
  return join(configDir, entry.kind === "agent" ? "agents" : "commands", entry.file);
}

function sourcePath(entry: FleetEntry, options: Pick<FleetOptions, "root"> = {}): string {
  return join(fleetAssetsRoot(options), entry.kind === "agent" ? "agents" : entry.kind === "command" ? "commands" : "docs", entry.file);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Loads and validates the committed manifest. Fail closed: a malformed or
 * drifted-shape manifest is an error, never an empty fleet.
 */
export function loadFleetManifest(options: Pick<FleetOptions, "root"> = {}): FleetManifest {
  const parsed: unknown = JSON.parse(readFileSync(join(fleetAssetsRoot(options), "manifest.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new TypeError("fleet manifest is not an object");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) throw new TypeError(`fleet manifest version must be 1 (got ${String(record.version)})`);
  if (!Array.isArray(record.entries)) throw new TypeError("fleet manifest entries must be an array");
  const entries = record.entries.map((raw): FleetEntry => {
    if (typeof raw !== "object" || raw === null) throw new TypeError("fleet manifest entry is not an object");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) throw new TypeError("fleet manifest entry requires a non-empty id");
    if (typeof entry.kind !== "string" || !KINDS.includes(entry.kind as FleetKind)) {
      throw new TypeError(`fleet manifest entry ${String(entry.id)} has an unknown kind: ${String(entry.kind)}`);
    }
    if (typeof entry.file !== "string" || !entry.file.endsWith(".md") || basename(entry.file) !== entry.file) {
      throw new TypeError(`fleet manifest entry ${String(entry.id)} has a non-basename file: ${String(entry.file)}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new TypeError(`fleet manifest entry ${String(entry.id)} has a malformed sha256`);
    }
    return { id: entry.id, kind: entry.kind as FleetKind, file: entry.file, sha256: entry.sha256 };
  });
  return { version: 1, entries };
}

/** Compares every vendored entry against the installed tree: current / missing / differs. */
export function compareFleet(options: FleetOptions = {}): readonly FleetStatus[] {
  const manifest = loadFleetManifest(options);
  return selectedEntries(manifest, options.kinds).map((entry) => {
    const target = fleetTarget(entry, options);
    let state: FleetEntryState;
    try {
      state = sha256File(target) === entry.sha256 ? "current" : "differs";
    } catch {
      state = "missing";
    }
    return { entry, target, state };
  });
}

/** The exact shell command that installs one entry by hand (what the doctor prints). */
export function fleetCopyCommand(status: FleetStatus, options: Pick<FleetOptions, "root"> = {}): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const source = sourcePath(status.entry, options);
  return `cp ${quote(source)} ${quote(status.target)}`;
}

/**
 * The hub-owned OpenCode config-dir installer: deploys the vendored AGENTS and
 * COMMANDS (never the workspace-owned docs bundle) into `$XDG_CONFIG_HOME/opencode`,
 * overwriting a stale copy (the config dir is hub-owned and regenerated, so there
 * are no operator edits to preserve). `configDir` is the XDG_CONFIG_HOME root the
 * lane launches `opencode` with; the fleet lands at `join(configDir, "opencode",
 * {agents,commands})`, exactly where OpenCode scans. Shared by the server runtime
 * and the ACP runtime so both lanes install identically from one tested definition.
 */
export function installFleetIntoOpencodeConfig(configDir: string): readonly FleetInstallResult[] {
  return installFleet({ configDir: join(configDir, "opencode"), kinds: ["agent", "command"], force: true });
}

/**
 * Deploys the fleet. Agents/commands refuse to clobber a locally-modified
 * install unless `force` is set; docs are install-if-missing only (never
 * overwritten, force or not). Writes are atomic (temp file + rename) and
 * nothing is ever deleted.
 */
export function installFleet(options: FleetOptions & { readonly force?: boolean } = {}): readonly FleetInstallResult[] {
  const manifest = loadFleetManifest(options);
  return selectedEntries(manifest, options.kinds).map((entry) => {
    const target = fleetTarget(entry, options);
    let installedHash: string | undefined;
    try {
      installedHash = sha256File(target);
    } catch {
      installedHash = undefined;
    }
    if (installedHash === entry.sha256) {
      return { entry, target, action: "already-current" as const };
    }
    if (installedHash !== undefined) {
      if (entry.kind === "doc") {
        return { entry, target, action: "skipped-repo-doc" as const };
      }
      if (options.force !== true) {
        return { entry, target, action: "skipped-local-modified" as const };
      }
    }
    const source = sourcePath(entry, options);
    const payload = readFileSync(source);
    mkdirSync(dirnameOf(target), { recursive: true });
    const staging = `${target}.install-${process.pid}.tmp`;
    writeFileSync(staging, payload);
    renameSync(staging, target);
    return { entry, target, action: installedHash === undefined ? "written" as const : "forced" as const };
  });
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : ".";
}

/** Arg parsing for `workflow install fleet [--force]`. Unknown verbs fail closed. */
export function parseInstallArgs(rest: readonly string[]): { item?: "fleet"; force: boolean; error?: string } {
  let item: "fleet" | undefined;
  let force = false;
  const unknown: string[] = [];
  for (const token of rest) {
    if (token === "fleet") item = "fleet";
    else if (token === "--force") force = true;
    else unknown.push(token);
  }
  if (item === undefined) {
    return { force, error: "workflow install requires an item: fleet (usage: workflow install fleet [--force])" };
  }
  if (unknown.length > 0) {
    return { item, force, error: `workflow install fleet: unrecognized argument(s): ${unknown.join(" ")}` };
  }
  return { item, force };
}
