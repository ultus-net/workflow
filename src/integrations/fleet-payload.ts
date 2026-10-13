import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { foldFleetAmbientDocs, normalizeFleetEntry } from "./fleet-agent-install.js";

/**
 * W086 — the control-plane fleet payload: the OpenCode golden tree (agents,
 * commands, root instructions, the style floor, the RSI scaffolding templates,
 * the code-cheatsheet skill, and the harness `lib/` rulers) plus the companion
 * repo docs the fleet references, vendored into this repository under
 * `assets/opencode-fleet/` with a committed sha256 manifest (regenerate via
 * `node scripts/generate-fleet-manifest.mjs`).
 *
 * Trust boundary, stated precisely (the guard-policy tier model,
 * 2026-09-21): the vendored assets are versioned source — PR review carries
 * their audit. `installFleet` writes ONLY into the operator-invoked targets
 * (the host agent/command/instruction/style/template/skill/lib trees and,
 * install-if-missing only, the workspace's docs/agents files). It never
 * touches the root host config document (`opencode.jsonc`) — that file is the
 * permission surface and stays operator-owned; the vendored `host-config/`
 * copies are reference-only (for review and the doctor's fragment print), and
 * the installer never writes them. Nothing here runs unattended: running
 * `workflow install fleet` is the operator's ask-gate.
 *
 * The docs bundle is install-if-missing by design: `lessons.md` is a
 * per-repo append-only memory and the other docs are repo-owned living
 * documents — the installer never overwrites any of them, with or without
 * force. Drift is the doctor's job to surface, not the installer's to
 * destroy.
 */

export type FleetKind =
  | "agent"
  | "command"
  | "doc"
  | "instruction"
  | "style"
  | "template"
  | "skill"
  | "lib"
  | "host-config";

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
   * Restrict install/compare to these kinds (default: every installable kind —
   * `host-config` is reference-only and never installed). The plane runtime
   * installs only the config surface the agents depend on into its hub-owned
   * config dir and never the workspace docs, so it passes
   * {@link RUNTIME_FLEET_KINDS}.
   */
  readonly kinds?: readonly FleetKind[];
  /**
   * Install-time payload transform (hub-owned runtime lanes): applied to the
   * source bytes just before the atomic write, so the vendored source stays
   * byte-identical while the installed copy is normalized for the plane
   * (model-tier provider rewrite, host-specific permission stripping — see
   * `fleet-agent-install.ts`). `compareFleet` accepts the same transform so it
   * judges the on-disk copy against the transformed payload rather than the raw
   * source; the CLI lane passes none and stays byte-for-byte.
   */
  readonly transform?: ((entry: FleetEntry, payload: Buffer) => Buffer) | undefined;
}

/** Per-kind placement: where the source lives and where (if ever) it installs. */
interface KindSpec {
  /** Source subdirectory under `assets/opencode-fleet/`. */
  readonly dir: string;
  /** Host config subdirectory for installable kinds (absent ⇒ the config dir root). */
  readonly installSubdir?: string;
  /** Workspace subdirectory for docs (absent ⇒ not workspace-installed). */
  readonly workspaceSubdir?: string;
  /** Docs are repo-owned living files: install-if-missing only, never overwritten. */
  readonly installIfMissingOnly?: boolean;
  /** Reference-only: vendored for review + the doctor's fragment print, never installed. */
  readonly referenceOnly?: boolean;
}

const KIND_SPECS: Record<FleetKind, KindSpec> = {
  agent: { dir: "agents", installSubdir: "agents" },
  command: { dir: "commands", installSubdir: "commands" },
  instruction: { dir: "instructions" },
  style: { dir: "style", installSubdir: "style" },
  template: { dir: "templates", installSubdir: "templates" },
  skill: { dir: "skills", installSubdir: "skills" },
  lib: { dir: "lib", installSubdir: "lib" },
  doc: { dir: "docs", workspaceSubdir: "agents", installIfMissingOnly: true },
  "host-config": { dir: "host-config", referenceOnly: true },
};

const KINDS = Object.keys(KIND_SPECS) as readonly FleetKind[];
const INSTALLABLE_KINDS: readonly FleetKind[] = KINDS.filter((kind) => KIND_SPECS[kind].referenceOnly !== true);

/**
 * The config-dir kinds the hub-owned runtime lanes install: agents, commands,
 * and the instruction/style/template files the agent prompts reference. Skills
 * are NOT config-dir files — they are provisioned into the hub-owned skills
 * store the journaled `read_skill` path reads (see `provisionFleetSkills`),
 * never under the OpenCode config dir. `doc` stays excluded (workspace-owned)
 * and `host-config` stays reference-only.
 */
export const RUNTIME_FLEET_KINDS: readonly FleetKind[] = ["agent", "command", "instruction", "style", "template"];

/**
 * The hub-owned runtime-lane payload transform: agents are normalized for the
 * plane (metered model provider, unmappable permission actions stripped — see
 * `fleet-agent-install.ts`); the global `AGENTS.md` gets the fleet ambient docs
 * (`STANDARDS.md`, `style/coding-style.md`) folded in, because OpenCode v2
 * honors ONLY discovered `AGENTS.md` and ignores the config `instructions` array
 * (measured 2026-10-13; `foldFleetAmbientDocs`); every other kind is
 * byte-identical. A factory so the installer and the doctor's compare agree on
 * exactly what "current" means AND resolve the sibling docs from the SAME
 * `root` the caller compares against (no silent mismatch).
 */
export function runtimeFleetTransform(
  options: Pick<FleetOptions, "root"> = {},
): (entry: FleetEntry, payload: Buffer) => Buffer {
  return (entry, payload) => {
    if (entry.kind === "instruction" && entry.file === "AGENTS.md") {
      return foldFleetAmbientDocs(payload, loadAmbientFoldDocs(options));
    }
    return normalizeFleetEntry(entry, payload);
  };
}

/** The ambient docs folded into the runtime `AGENTS.md`, in fixed order. */
function loadAmbientFoldDocs(options: Pick<FleetOptions, "root">): readonly { readonly label: string; readonly payload: Buffer }[] {
  const manifest = loadFleetManifest(options);
  const wanted: readonly { readonly label: string; readonly file: string }[] = [
    { label: "STANDARDS.md", file: "STANDARDS.md" },
    { label: "style/coding-style.md", file: "coding-style.md" },
  ];
  return wanted.map(({ label, file }) => {
    const entry = manifest.entries.find((candidate) => candidate.kind === (file === "coding-style.md" ? "style" : "instruction") && candidate.file === file);
    if (entry === undefined) throw new TypeError(`fleet ambient doc ${label} is missing from the manifest`);
    return { label, payload: readFileSync(sourcePath(entry, options)) };
  });
}

function specFor(kind: FleetKind): KindSpec {
  return KIND_SPECS[kind];
}

/**
 * Manifest entries narrowed to the requested kinds (all installable kinds when
 * absent). Reference-only kinds are always excluded: even an explicit request
 * cannot make the permission surface installable.
 */
function selectedEntries(manifest: FleetManifest, kinds: readonly FleetKind[] | undefined): readonly FleetEntry[] {
  const wanted = kinds === undefined ? INSTALLABLE_KINDS : kinds.filter((kind) => specFor(kind).referenceOnly !== true);
  return manifest.entries.filter((entry) => wanted.includes(entry.kind));
}

/** Vendored assets directory: an explicit root wins; otherwise this package's own checkout/install. */
export function fleetAssetsRoot(options: Pick<FleetOptions, "root"> = {}): string {
  if (options.root !== undefined) return join(options.root, "assets", "opencode-fleet");
  return fileURLToPath(new URL("../../assets/opencode-fleet/", import.meta.url));
}

/** Where an entry installs: config kinds under the host config dir, docs under the workspace repo. */
export function fleetTarget(entry: FleetEntry, options: Pick<FleetOptions, "home" | "workspace" | "configDir"> = {}): string {
  const spec = specFor(entry.kind);
  if (spec.referenceOnly === true) throw new TypeError(`fleet entry ${entry.id} is reference-only and has no install target`);
  if (spec.workspaceSubdir !== undefined) {
    return join(options.workspace ?? process.cwd(), "docs", spec.workspaceSubdir, entry.file);
  }
  const configDir = options.configDir ?? join(options.home ?? homedir(), ".config", "opencode");
  return join(configDir, ...(spec.installSubdir === undefined ? [] : [spec.installSubdir]), entry.file);
}

function sourcePath(entry: FleetEntry, options: Pick<FleetOptions, "root"> = {}): string {
  return join(fleetAssetsRoot(options), specFor(entry.kind).dir, entry.file);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Buffer(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** A manifest file path is a relative POSIX subpath: no absolute root, no `..` escape, no backslash. */
function isSafeRelativeFile(file: string): boolean {
  if (file.length === 0 || file.startsWith("/") || file.includes("\\")) return false;
  const segments = file.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
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
    if (typeof entry.file !== "string" || !isSafeRelativeFile(entry.file)) {
      throw new TypeError(`fleet manifest entry ${String(entry.id)} has an unsafe file path: ${String(entry.file)}`);
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
    // Judge the on-disk copy against the payload the installer WOULD write: a
    // runtime lane's transform (agent normalization) is the expected content,
    // so a correctly installed runtime tree reports `current`, never a
    // spurious `differs`. The CLI lane supplies no transform and stays raw.
    const expected = options.transform === undefined ? entry.sha256 : sha256Buffer(options.transform(entry, readFileSync(sourcePath(entry, options))));
    let state: FleetEntryState;
    try {
      state = sha256File(target) === expected ? "current" : "differs";
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
  // Nested kinds (templates/rsi/*, skills/<name>/*, lib/vendor/*) install into
  // subdirectories that may not exist yet, so the hand-copy creates the parent
  // the same way installFleet does. A flat target still gets a harmless mkdir -p.
  return `mkdir -p ${quote(dirname(status.target))} && cp ${quote(source)} ${quote(status.target)}`;
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
  return installFleet({
    configDir: join(configDir, "opencode"),
    kinds: RUNTIME_FLEET_KINDS,
    force: true,
    transform: runtimeFleetTransform(),
  });
}

/**
 * Provisions the fleet `skill` kind into the hub-owned skills-mcp delivery
 * store — `<skillsDir>/<name>/<file>` — the directory `skills-mcp` scans and
 * the journaled `read_skill` reads. This is the SANCTIONED delivery path for
 * the vendored skills (e.g. `code-cheatsheet`, which `/explain` loads); the
 * plane's native `permission: { skill: "deny" }` is untouched because the
 * model reaches skill content through `read_skill`, never a native skill tool.
 *
 * Skills are NOT config-dir files (the runtime config-dir install excludes the
 * `skill` kind), so they land only here. Writes only on create or content
 * drift (byte-compare — no churn on every session); parent directories are
 * created as needed. Returns every copied target path (skill sources may be
 * nested, e.g. `code-cheatsheet/template.md`).
 */
export interface ProvisionFleetSkillsIo {
  readonly mkdirSync?: (path: string, options: { recursive: boolean; mode?: number }) => unknown;
  readonly existsSync?: (path: string) => boolean;
  readonly readFileSync?: (path: string) => Buffer;
  readonly writeFileSync?: (path: string, data: Buffer, options: { mode: number }) => unknown;
}

export function provisionFleetSkills(
  skillsDir: string,
  options: Pick<FleetOptions, "root"> & ProvisionFleetSkillsIo = {},
): readonly string[] {
  const manifest = loadFleetManifest(options);
  const mkdir = options.mkdirSync ?? ((path: string, opts: { recursive: boolean; mode?: number }) => mkdirSync(path, opts));
  const exists = options.existsSync ?? ((path: string) => existsSync(path));
  const read = options.readFileSync ?? ((path: string) => readFileSync(path));
  const write = options.writeFileSync ?? ((path: string, data: Buffer, opts: { mode: number }) => writeFileSync(path, data, opts));
  const written: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== "skill") continue;
    const source = sourcePath(entry, options);
    const target = join(skillsDir, entry.file);
    const payload = read(source);
    if (exists(target)) {
      try {
        if (Buffer.compare(read(target), payload) === 0) continue;
      } catch {
        // Fall through to a rewrite when the existing copy cannot be read.
      }
    }
    mkdir(dirname(target), { recursive: true, mode: 0o700 });
    write(target, payload, { mode: 0o600 });
    written.push(target);
  }
  return written;
}

/**
 * Deploys the fleet. Config kinds (agents/commands/instructions/style/templates/
 * skills/lib) refuse to clobber a locally-modified install unless `force` is
 * set; docs are install-if-missing only (never overwritten, force or not).
 * Writes are atomic (temp file + rename) and nothing is ever deleted.
 */
export function installFleet(options: FleetOptions & { readonly force?: boolean } = {}): readonly FleetInstallResult[] {
  const manifest = loadFleetManifest(options);
  return selectedEntries(manifest, options.kinds).map((entry) => {
    const target = fleetTarget(entry, options);
    const installIfMissingOnly = specFor(entry.kind).installIfMissingOnly === true;
    // The expected payload: the raw source for the CLI lane, or the runtime
    // lane's normalized copy (agent model/permission transform). Comparing
    // against it keeps a correctly-normalized installed tree `already-current`.
    const source = sourcePath(entry, options);
    const payload = options.transform === undefined ? readFileSync(source) : options.transform(entry, readFileSync(source));
    let installedHash: string | undefined;
    try {
      installedHash = sha256File(target);
    } catch {
      installedHash = undefined;
    }
    if (installedHash === sha256Buffer(payload)) {
      return { entry, target, action: "already-current" as const };
    }
    if (installedHash !== undefined) {
      if (installIfMissingOnly) {
        return { entry, target, action: "skipped-repo-doc" as const };
      }
      if (options.force !== true) {
        return { entry, target, action: "skipped-local-modified" as const };
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    const staging = `${target}.install-${process.pid}.tmp`;
    writeFileSync(staging, payload);
    renameSync(staging, target);
    return { entry, target, action: installedHash === undefined ? "written" as const : "forced" as const };
  });
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
