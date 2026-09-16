#!/usr/bin/env node
/**
 * Vendor curated agent skills into the operator-managed skills directory —
 * the single surface skills-mcp and the hub's pedagogy gating both read
 * (SKILLS_MCP_DIR, default ~/.agents/skills).
 *
 * Ownership model: this script is the only writer of the skill directories it
 * imports. Provenance lives in vendor-skills.json inside the target directory
 * — a plain file, invisible to skills-mcp's scanner exactly like levels.json
 * (the scanner only reads <name>/SKILL.md directories). Re-runs update owned
 * skills to the upstream state; --prune removes owned skills that left the
 * selection; --archive moves pre-existing unowned skill directories into
 * .archive/<timestamp>/ (a dot directory the scanner's name pattern rejects)
 * so a vendored corpus can replace a handcrafted one without deleting
 * anything.
 *
 * Fail-closed rules:
 * - An existing directory with a selected skill's name that provenance does
 *   not own is never overwritten; the import refuses and reports.
 * - Duplicate skill names across sources are refused, not silently merged.
 * - Prune only runs when every source was acquired: a failed source makes
 *   the selection view partial, and pruning on a partial view would delete
 *   live skills.
 * - A prefix subdirectory without SKILL.md is not a skill (category
 *   containers are ignored); a SKILL.md without frontmatter description is
 *   invisible to list_skills and is reported as a skip, never silently
 *   dropped.
 *
 * Update policy: updates are deliberate operator re-runs, never scheduled.
 * skills-mcp re-screens every skill at delivery time (the file may have
 * changed since discovery), which is the designed compensating control for
 * upstream content changing between runs.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROVENANCE_FILE = "vendor-skills.json";
const PROVENANCE_VERSION = 1;

/**
 * Default curation (docs/superpowers/plans/2026-09-16-skills-import-lifecycle.md):
 * obra/superpowers is flat (skills/<name>); mattpocock/skills is
 * category-nested and only engineering/ plus productivity/ are curated in —
 * deprecated/, in-progress/, and misc/ stay out. Name audit 2026-09-16: the
 * two selections do not collide.
 */
export const DEFAULT_SOURCES = [
  {
    name: "obra/superpowers",
    repo: "https://github.com/obra/superpowers.git",
    include: ["skills/*"],
  },
  {
    name: "mattpocock/skills",
    repo: "https://github.com/mattpocock/skills.git",
    include: ["skills/engineering/*", "skills/productivity/*"],
  },
];

/** Same default-dir semantics as skills-mcp's server and the hub's pedagogy gating resolver. */
export function resolveSkillsDir(explicit) {
  return path.resolve(explicit ?? process.env.SKILLS_MCP_DIR ?? path.join(homedir(), ".agents", "skills"));
}

/** Frontmatter description, mirroring skills-mcp's own minimal parse. */
function frontmatterDescription(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const header = match?.[1] ?? "";
  const line = header.split(/\r?\n/).find((candidate) => /^description:/.test(candidate));
  return line === undefined ? undefined : line.replace(/^description:\s*/, "").trim();
}

/**
 * Expand `<prefix>/*` include patterns against a source root. A prefix
 * subdirectory carries a skill only when it contains SKILL.md — the
 * directory name is the skill name, the identity skills-mcp resolves by
 * (a disagreeing frontmatter name must never fork identity).
 */
export function listSkillCandidates(sourceRoot, include) {
  const candidates = [];
  const problems = [];
  for (const pattern of include) {
    if (!/^(?:[^/*]+\/)*\*$/.test(pattern)) {
      problems.push(`invalid include pattern '${pattern}' (expected '<dir>/*')`);
      continue;
    }
    const prefixDir = path.join(sourceRoot, ...pattern.slice(0, -2).split("/"));
    if (!existsSync(prefixDir)) {
      problems.push(`include directory missing: '${pattern}'`);
      continue;
    }
    for (const entry of readdirSync(prefixDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(prefixDir, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const description = frontmatterDescription(readFileSync(skillFile, "utf8"));
      candidates.push({ name: entry.name, dir: skillDir, description });
    }
  }
  return { candidates, problems };
}

/**
 * Load the provenance map (skill name -> where it came from). Absent file is
 * an empty map; a malformed file — or an unknown format version — throws:
 * the operator must not lose the ownership record that gates overwrites, and
 * a future format must not be silently misread as v1.
 */
export function loadProvenance(skillsDir) {
  const file = path.join(skillsDir, PROVENANCE_FILE);
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`invalid ${PROVENANCE_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.skills !== "object" || parsed.skills === null) {
    throw new Error(`invalid ${PROVENANCE_FILE}: expected { version, importedAt, skills }`);
  }
  if (parsed.version !== PROVENANCE_VERSION) {
    throw new Error(`unsupported ${PROVENANCE_FILE} version: ${String(parsed.version)} (expected ${PROVENANCE_VERSION}) — migrate or remove the file`);
  }
  return parsed.skills;
}

/** Shallow-clone a source repo and report its HEAD commit for provenance. */
async function defaultClone(repo, dest) {
  execFileSync("git", ["clone", "--depth", "1", "--quiet", repo, dest]);
  return execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function acquireSource(source, clone) {
  if (typeof source.repo === "string") {
    const root = mkdtempSync(path.join(tmpdir(), "vendor-skills-"));
    let commit;
    try {
      commit = await clone(source.repo, root);
    } catch (error) {
      // A failed clone must not leak its temp directory — the caller only
      // cleans up on the success path.
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    return { root, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  if (typeof source.path === "string") {
    return { root: path.resolve(source.path), cleanup: undefined };
  }
  throw new Error("source must carry 'repo' (git URL) or 'path' (local directory)");
}

/** Move every unowned skill-shaped directory into .archive/<timestamp>/. */
function archiveUnownedSkills(skillsDir, provenance, timestamp) {
  const archived = [];
  const archiveRoot = path.join(skillsDir, ".archive", timestamp);
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (provenance[entry.name] !== undefined) continue;
    if (!existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) continue;
    mkdirSync(archiveRoot, { recursive: true });
    renameSync(path.join(skillsDir, entry.name), path.join(archiveRoot, entry.name));
    archived.push(entry.name);
  }
  return archived;
}

/**
 * Import (and update) the curated selection into the skills directory.
 * Returns an honest report; writes nothing when dryRun is set.
 */
export async function importSkills(options) {
  const skillsDir = options.skillsDir;
  const prune = options.prune === true;
  const archive = options.archive === true;
  const dryRun = options.dryRun === true;
  const clone = options.clone ?? defaultClone;
  const report = {
    imported: [],
    updated: [],
    refused: [],
    skipped: [],
    pruned: [],
    archived: [],
    problems: [],
  };
  const oldProvenance = loadProvenance(skillsDir);
  mkdirSync(skillsDir, { recursive: true });

  // Phase 1: acquire every source and collect its candidates.
  const selections = [];
  for (const source of options.sources) {
    let acquired;
    try {
      acquired = await acquireSource(source, clone);
    } catch (error) {
      report.problems.push(`source '${source.name}' failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const { candidates, problems } = listSkillCandidates(acquired.root, source.include);
      for (const problem of problems) report.problems.push(`source '${source.name}': ${problem}`);
      for (const candidate of candidates) {
        if (candidate.description === undefined || candidate.description.length === 0) {
          report.skipped.push({
            name: candidate.name,
            reason: "SKILL.md has no frontmatter description — invisible to list_skills",
          });
          continue;
        }
        selections.push({ source, candidate, commit: acquired.commit, root: acquired.root });
      }
    } finally {
      acquired.cleanup?.();
    }
  }

  // Phase 2: cross-source duplicate names are refused, never silently merged.
  const byName = new Map();
  for (const selection of selections) {
    byName.set(selection.candidate.name, [...(byName.get(selection.candidate.name) ?? []), selection]);
  }
  const finalSelection = [];
  for (const [name, group] of byName) {
    if (group.length > 1) {
      const sourceNames = group.map((selection) => selection.source.name).join(", ");
      report.refused.push({ name, reason: `duplicate across sources (${sourceNames})` });
      continue;
    }
    finalSelection.push(group[0]);
  }

  // Phase 3: archive pre-existing unowned skills so a vendored corpus can
  // replace a handcrafted one without deleting anything.
  if (archive && !dryRun) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    report.archived.push(...archiveUnownedSkills(skillsDir, oldProvenance, timestamp));
  }

  // Phase 4: import or update each selected skill; refuse unowned collisions.
  const importedProvenance = {};
  for (const { source, candidate, commit, root } of finalSelection) {
    const target = path.join(skillsDir, candidate.name);
    const owned = oldProvenance[candidate.name] !== undefined;
    if (existsSync(target) && !owned) {
      report.refused.push({
        name: candidate.name,
        reason: "target directory exists and is not owned by the vendor (use --archive to move it aside)",
      });
      continue;
    }
    const record = {
      source: source.name,
      originPath: path.relative(root, candidate.dir),
      ...(commit === undefined ? {} : { commit }),
    };
    if (!dryRun) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true }); // clean update: no stale files survive
      cpSync(candidate.dir, target, { recursive: true, dereference: true });
      importedProvenance[candidate.name] = record;
    }
    (owned ? report.updated : report.imported).push(candidate.name);
  }

  // Phase 5: prune owned skills that left the selection. Refused duplicates
  // stay owned and are kept — a refusal must never delete the live skill.
  // Note the boundary of "left the selection": an owned skill whose upstream
  // SKILL.md lost its frontmatter description is a reported skip, not a
  // selection, so --prune removes its (now list_skills-invisible) directory —
  // the same run reports both the skip and the prune, so nothing is silent.
  if (prune) {
    if (report.problems.length > 0) {
      report.problems.push("prune skipped: at least one source failed — refusing to prune on a partial selection view");
    } else {
      for (const name of Object.keys(oldProvenance)) {
        if (byName.has(name)) continue;
        if (!dryRun) rmSync(path.join(skillsDir, name), { recursive: true, force: true });
        report.pruned.push(name);
      }
    }
  }

  if (!dryRun) {
    // Retained ownership: keep entries for owned skills that were refused or
    // (without --prune) left the selection; refresh imported and updated ones;
    // drop pruned ones.
    const provenance = { ...oldProvenance, ...importedProvenance };
    for (const name of report.pruned) delete provenance[name];
    writeFileSync(
      path.join(skillsDir, PROVENANCE_FILE),
      JSON.stringify({ version: PROVENANCE_VERSION, importedAt: new Date().toISOString(), skills: provenance }, null, 2) + "\n",
    );
  }
  return report;
}

function usage() {
  return [
    "vendor-skills — vendor curated agent skills into the skills-mcp directory",
    "",
    "Usage: node scripts/vendor-skills.mjs [options]",
    "",
    "Options:",
    "  --dir <path>       Target skills directory (default: SKILLS_MCP_DIR or ~/.agents/skills)",
    "  --sources <file>   JSON array of sources [{ name, repo | path, include: [\"skills/*\"] }]",
    "                     (default: the curated obra/superpowers + mattpocock/skills set)",
    "  --list             Dry run: report what would be imported and refused, write nothing",
    "  --prune            Remove vendor-owned skills that left the selection",
    "  --archive          Move pre-existing unowned skill directories into .archive/<timestamp>/",
    "  -h, --help         Show this help",
    "",
    "Update policy: re-run deliberately to update; skills-mcp re-screens content at",
    "every delivery. Exit code 1 when anything was refused, skipped, or failed.",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { dir: undefined, sourcesFile: undefined, list: false, prune: false, archive: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--dir") {
      if (value === undefined) throw new Error("--dir requires a value");
      parsed.dir = value;
      index += 1;
    } else if (arg.startsWith("--dir=")) parsed.dir = arg.slice("--dir=".length);
    else if (arg === "--sources") {
      if (value === undefined) throw new Error("--sources requires a value");
      parsed.sourcesFile = value;
      index += 1;
    } else if (arg.startsWith("--sources=")) parsed.sourcesFile = arg.slice("--sources=".length);
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--prune") parsed.prune = true;
    else if (arg === "--archive") parsed.archive = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

async function loadSources(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((source) => typeof source === "object" && source !== null && typeof source.name === "string" && Array.isArray(source.include))) {
    throw new Error(`invalid sources file: expected an array of { name, repo | path, include }`);
  }
  return parsed;
}

function printReport(skillsDir, report, dry) {
  const summary = dry ? "dry run — nothing written" : "done";
  console.log(`skills directory: ${skillsDir} (${summary})`);
  for (const name of report.imported) console.log(`  imported: ${name}`);
  for (const name of report.updated) console.log(`  updated:  ${name}`);
  for (const name of report.pruned) console.log(`  pruned:   ${name}`);
  for (const name of report.archived) console.log(`  archived: ${name} (moved to .archive/)`);
  for (const refusal of report.refused) console.log(`  REFUSED:  ${refusal.name} — ${refusal.reason}`);
  for (const skip of report.skipped) console.log(`  skipped:  ${skip.name} — ${skip.reason}`);
  for (const problem of report.problems) console.log(`  problem:  ${problem}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const sources = args.sourcesFile === undefined ? DEFAULT_SOURCES : await loadSources(args.sourcesFile);
  const skillsDir = resolveSkillsDir(args.dir);
  const report = await importSkills({
    skillsDir,
    sources,
    prune: args.prune,
    archive: args.archive,
    dryRun: args.list,
  });
  printReport(skillsDir, report, args.list);
  return report.refused.length > 0 || report.skipped.length > 0 || report.problems.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "vendor-skills")).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}