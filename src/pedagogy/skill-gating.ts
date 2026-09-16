import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { TaskId } from "../kernel/contracts.js";
import type { PedagogicalMode } from "./contracts.js";

/**
 * Plan Task F2: learner level → skill availability and requirements.
 *
 * The map file (`levels.json` in the skills directory) is shared with
 * skills-mcp, so the server's availability gating and the hub's required-
 * skills precondition always read the same operator configuration:
 *
 * ```json
 * {
 *   "learn-to-code": { "unlocked": ["test-driven-development"], "required": ["test-driven-development"] },
 *   "autonomous":    { "unlocked": ["test-driven-development", "code-review"], "required": [] }
 * }
 * ```
 *
 * Modes with no entry are `closed` in skills-mcp (nothing listed). The hub
 * side fails closed the same way: no entry → no skills unlocked and no
 * mutations gated (the mode simply has no skill contract yet); a mode entry
 * with `required` names feeds WorkflowApplication.setTaskRequiredSkills.
 */

export interface SkillLevelGate {
  readonly unlocked: readonly string[];
  readonly required: readonly string[];
}

export type SkillsLevelMap = Record<string, SkillLevelGate>;

export interface SkillGating {
  readonly mode: PedagogicalMode;
  readonly unlocked: readonly string[];
  readonly required: readonly string[];
  readonly configured: boolean;
}

export function loadSkillsLevelMap(skillsDir: string): SkillsLevelMap | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(skillsDir, "levels.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid levels.json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return requireLevelMap(parsed);
}

export function skillGatingFor(mode: PedagogicalMode, levelMap: SkillsLevelMap | undefined): SkillGating {
  if (levelMap === undefined) {
    return { mode, unlocked: [], required: [], configured: false };
  }
  const gate = levelMap[mode];
  if (gate === undefined) {
    // skills-mcp lists nothing for a mode with no entry (closed). The hub
    // side has no skill contract for this mode either.
    return { mode, unlocked: [], required: [], configured: false };
  }
  return { mode, unlocked: gate.unlocked, required: gate.required, configured: true };
}

/**
 * The composition target for surfaces that switch pedagogical modes: the
 * active task is the one whose mutations the required-skill precondition
 * gates.
 */
export interface SkillGatingTarget {
  setTaskRequiredSkills(taskId: TaskId, skills: readonly string[]): void;
  activeTaskId(): TaskId;
}

/**
 * Plan Task F2 surface wiring: bind the mode's required-skill set to the
 * active task. A mode with no required skills (autonomous, unconfigured, or
 * absent level map) clears the precondition, so switching modes never leaves
 * a stale requirement behind. Fails closed on the caller's contract: throws
 * when no task is active, never silently skips gating.
 */
export function applySkillGating(
  target: SkillGatingTarget,
  mode: PedagogicalMode,
  levelMap: SkillsLevelMap | undefined,
): void {
  target.setTaskRequiredSkills(target.activeTaskId(), skillGatingFor(mode, levelMap).required);
}

/**
 * Loads the level map from the same operator-managed skills directory
 * skills-mcp reads (`SKILLS_MCP_DIR`, default `~/.agents/skills`), so
 * server-side availability and hub-side requirements share one config. An
 * absent `levels.json` means no map (gating composes to no-ops); a malformed
 * one throws — the surface must refuse to run ungated, mirroring skills-mcp.
 */
export function resolveSkillsLevelMap(skillsDirOverride: string | undefined, homeDir: string): SkillsLevelMap | undefined {
  const dir = skillsDirOverride !== undefined && skillsDirOverride.trim().length > 0
    ? skillsDirOverride
    : join(homeDir, ".agents", "skills");
  return loadSkillsLevelMap(resolve(dir));
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
