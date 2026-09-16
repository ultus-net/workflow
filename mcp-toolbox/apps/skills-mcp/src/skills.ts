import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plan Task F1: skills reach the model only through this server. Discovery is
 * metadata-only; content costs a read_skill call. Skill names are single path
 * segments (no traversal) and skill directories live outside agent workspaces,
 * so a contained agent's raw read_file cannot bypass delivery.
 */

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
}

export interface SkillLevelGate {
  readonly unlocked: readonly string[];
  readonly required: readonly string[];
}

export type SkillsLevelMap = Record<string, SkillLevelGate>;

export type GatingState = "off" | "active" | "closed";

export interface GatedSkills {
  readonly skills: readonly SkillMeta[];
  readonly gating: GatingState;
  readonly level: string | undefined;
}

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/** Scans <skillsDir>/<name>/SKILL.md files into metadata (name + description). */
export function scanSkills(skillsDir: string): readonly SkillMeta[] {
  const skills: SkillMeta[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSkillName(entry.name)) continue;
    // The directory name IS the skill name: read_skill resolves names to
    // directories, so a disagreeing frontmatter name must never fork identity.
    const description = parseSkillFile(readFileOrUndefined(join(skillsDir, entry.name, "SKILL.md")));
    if (description === undefined) continue;
    skills.push({ name: entry.name, description });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Availability gating (plan Task F2): an operator-managed `levels.json` in the
 * skills directory maps pedagogical modes to unlocked/required skill sets.
 * Honest states: `off` (no map or no level configured — every skill listed),
 * `active` (level gated by its unlocked set), `closed` (a level is configured
 * and a map exists but has no entry for it — nothing is listed; a typo in the
 * gating config must not silently unlock everything).
 */
export function gateSkills(
  skills: readonly SkillMeta[],
  levelMap: SkillsLevelMap | undefined,
  level: string | undefined,
): GatedSkills {
  if (levelMap === undefined || level === undefined) {
    return { skills, gating: "off", level };
  }
  const gate = levelMap[level];
  if (gate === undefined) {
    return { skills: [], gating: "closed", level };
  }
  const unlocked = new Set(gate.unlocked);
  return { skills: skills.filter((skill) => unlocked.has(skill.name)), gating: "active", level };
}

/**
 * Read-time level enforcement (plan Task F2, review follow-up): list gating
 * alone would let a learner read a locked skill by guessing its name. When
 * gating is active, only unlocked ∪ required skills are readable; a closed
 * level (configured but missing from the map) denies all reads — fail closed.
 */
export function skillReadableAt(
  levelMap: SkillsLevelMap | undefined,
  level: string | undefined,
  name: string,
): { readonly allowed: boolean; readonly reason?: string } {
  if (levelMap === undefined || level === undefined) {
    return { allowed: true };
  }
  const gate = levelMap[level];
  if (gate === undefined) {
    return { allowed: false, reason: `level '${level}' has no skill contract (gating closed)` };
  }
  const readable = new Set([...gate.unlocked, ...gate.required]);
  if (readable.has(name)) return { allowed: true };
  return { allowed: false, reason: `skill '${name}' is locked at level '${level}'` };
}

export function readSkillContent(skillsDir: string, name: string): string {
  if (!isSkillName(name)) throw new Error(`invalid skill name: '${name}'`);
  const content = readFileOrUndefined(join(skillsDir, name, "SKILL.md"));
  if (content === undefined) throw new Error(`unknown skill: '${name}'`);
  return content;
}

/** Loads the optional levels.json; a malformed map fails closed (throws). */
export function loadSkillsLevelMap(skillsDir: string): SkillsLevelMap | undefined {
  const raw = readFileOrUndefined(join(skillsDir, "levels.json"));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid levels.json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return requireLevelMap(parsed);
}

function requireLevelMap(value: unknown): SkillsLevelMap {
  if (typeof value !== "object" || value === null) throw new Error("invalid levels.json: expected an object");
  const map: SkillsLevelMap = {};
  for (const [level, gate] of Object.entries(value as Record<string, unknown>)) {
    if (typeof gate !== "object" || gate === null) throw new Error(`invalid levels.json: ${level} must be an object`);
    const record = gate as Record<string, unknown>;
    for (const key of ["unlocked", "required"] as const) {
      if (record[key] === undefined || !Array.isArray(record[key]) || !(record[key] as unknown[]).every((item) => typeof item === "string")) {
        throw new Error(`invalid levels.json: ${level}.${key} must be a string array`);
      }
    }
    map[level] = { unlocked: record.unlocked as string[], required: record.required as string[] };
  }
  return map;
}

function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseSkillFile(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const header = match?.[1] ?? "";
  return frontmatterKey(header, "description") ?? "";
}

function frontmatterKey(header: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const match = pattern.exec(header);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
