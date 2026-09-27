import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { RunBudget } from "./hub-scheduler.js";
import type { BoardOutcome, BoardTasks } from "./task-provider.js";

/**
 * W164 — the project container: the hub-owned "open a project" record
 * (Paperclip borrow, the `ProjectRepository` pattern). A project binds a
 * provider-stable repo identity (provider + fullName + provider repo id),
 * a status, a budget ENVELOPE, and workspace binding(s).
 *
 * Credential-free by construction: the identity is the fullName and the
 * provider's stable repo id — the provider credential (env-classified in
 * task-provider.ts) never enters this module, so no record can carry one.
 * The budget envelope rides the existing W045/W118 `RunBudget` shape (the
 * same caps the schedule table and the interactive session budget enforce);
 * the record carries the envelope only — enforcement stays with the
 * run-time budget machinery, nothing is rebuilt here.
 *
 * Persistence mirrors the schedule table's conventions ({version:1} file,
 * every write validated before it is admitted in memory, atomic 0o600
 * rename, an absent table means no projects, a corrupt file is refused —
 * never silently emptied).
 *
 * Single-authority dispatch: the registry exposes reads and record writes
 * ONLY (list/get/save/remove/boundWorkspaces). It has no run seam — starting
 * work in a bound workspace still crosses the application authority through
 * the hub's run routes; a project record can never dispatch anything.
 */

export interface ProjectRepoIdentity {
  readonly provider: "github";
  /** The provider-stable "owner/name" pair, verbatim. */
  readonly fullName: string;
  /** The provider's stable numeric repository id (survives renames). */
  readonly repoId: number;
}

export type ProjectStatus = "active" | "paused" | "archived";

export interface ProjectRecord {
  readonly id: string;
  readonly title: string;
  readonly repo: ProjectRepoIdentity;
  readonly status: ProjectStatus;
  /** The W045/W118 budget envelope (caps only; no accumulated usage state). */
  readonly budget?: RunBudget;
  /** The bound workspaces: a project-scoped query returns ONLY these. */
  readonly workspaces: readonly string[];
}

export interface ProjectRegistry {
  list(): readonly ProjectRecord[];
  get(id: string): ProjectRecord | undefined;
  /** Create or replace a project by id. Validates and persists before admitting. */
  save(record: ProjectRecord): readonly ProjectRecord[];
  remove(id: string): readonly ProjectRecord[];
  /** The project's bound workspaces; undefined for an unknown id — never
   * another project's bindings (the per-project scoping seam). */
  boundWorkspaces(id: string): readonly string[] | undefined;
}

export function createProjectRegistry(options: { readonly path: string }): ProjectRegistry {
  let projects: ProjectRecord[] = [...loadProjectsTable(options.path)];

  const persist = (next: readonly ProjectRecord[]): void => {
    // saveProjectsTable validates every entry and writes atomically; on any
    // failure it throws before the in-memory table changes.
    saveProjectsTable(options.path, next);
    projects = [...next];
  };

  return {
    list(): readonly ProjectRecord[] {
      return [...projects];
    },
    get(id: string): ProjectRecord | undefined {
      return projects.find((entry) => entry.id === id);
    },
    save(record: ProjectRecord): readonly ProjectRecord[] {
      requireProject(record);
      const existing = projects.findIndex((entry) => entry.id === record.id);
      const next = existing === -1
        ? [...projects, record]
        : projects.map((entry, index) => (index === existing ? record : entry));
      persist(next);
      return [...projects];
    },
    remove(id: string): readonly ProjectRecord[] {
      persist(projects.filter((entry) => entry.id !== id));
      return [...projects];
    },
    boundWorkspaces(id: string): readonly string[] | undefined {
      return projects.find((entry) => entry.id === id)?.workspaces;
    },
  };
}

// ── Persisted project table ────────────────────────────────────────────────

export function loadProjectsTable(path: string): readonly ProjectRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Only an absent table means "no projects". Permission or type errors
    // must not silently disable the project container.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`invalid project table: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new TypeError("invalid project table: unsupported or missing version");
  }
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) throw new TypeError("invalid project table: projects must be an array");
  return projects.map((entry) => requireProject(entry));
}

export function saveProjectsTable(path: string, projects: readonly ProjectRecord[]): void {
  const validated = projects.map((entry) => requireProject(entry));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, projects: validated }, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

/** The defensive record guard: what the table must supply for a project to
 * be admitted. Everything optional is either present-and-typed or absent —
 * a wrong-typed field refuses the record, never a guessed one. */
function requireProject(entry: unknown): ProjectRecord {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid project table: entry is not an object");
  const record = entry as Record<string, unknown>;
  for (const key of ["id", "title"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).trim().length === 0) {
      throw new TypeError(`invalid project table: ${key} must be a non-empty string`);
    }
  }
  const repo = record.repo;
  if (typeof repo !== "object" || repo === null) throw new TypeError("invalid project table: repo must be an object");
  const repoRecord = repo as Record<string, unknown>;
  if (repoRecord.provider !== "github") throw new TypeError("invalid project table: repo provider must be 'github'");
  if (
    typeof repoRecord.fullName !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repoRecord.fullName)
  ) {
    throw new TypeError("invalid project table: repo fullName must be 'owner/name'");
  }
  if (
    typeof repoRecord.repoId !== "number" || !Number.isInteger(repoRecord.repoId) || repoRecord.repoId <= 0
  ) {
    throw new TypeError("invalid project table: repo repoId must be a positive integer");
  }
  if (record.status !== "active" && record.status !== "paused" && record.status !== "archived") {
    throw new TypeError("invalid project table: status must be active, paused, or archived");
  }
  if (record.budget !== undefined) requireBudget(record.budget);
  const workspaces = record.workspaces;
  if (!Array.isArray(workspaces) || workspaces.some((workspace) => typeof workspace !== "string" || workspace.trim().length === 0)) {
    throw new TypeError("invalid project table: workspaces must be an array of non-empty strings");
  }
  return entry as ProjectRecord;
}

/** The budget envelope validates the same caps the schedule table does
 * (positive, finite numbers on each axis; absent axes stay absent). */
function requireBudget(entry: unknown): void {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid project table: budget must be an object");
  const budget = entry as Record<string, unknown>;
  for (const key of ["maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxCostUsd"] as const) {
    if (budget[key] === undefined) continue;
    if (typeof budget[key] !== "number" || !Number.isFinite(budget[key] as number) || (budget[key] as number) <= 0) {
      throw new TypeError(`invalid project table: budget ${key} must be a positive number`);
    }
  }
}

// ── Per-project board scoping ──────────────────────────────────────────────

/** The scoped board outcome: the project's own board, an honest
 * unavailable relay (provider faults pass through with their reason), or a
 * named refusal when the board reads a DIFFERENT repo than the project's
 * identity — a project-scoped query never returns a foreign repo's board. */
export type ProjectBoardScope =
  | { readonly kind: "ok"; readonly board: BoardTasks }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "foreign"; readonly reason: string };

export function projectScopedBoard(project: ProjectRecord, board: BoardOutcome | undefined): ProjectBoardScope {
  if (board === undefined) return { kind: "unavailable", reason: "no board read is available" };
  if (board.state === "unconfigured") {
    return { kind: "unavailable", reason: `the board provider is unconfigured (missing ${board.missing.join(", ")})` };
  }
  if (board.state === "error") return { kind: "unavailable", reason: board.reason };
  if (board.board.repo === project.repo.fullName) return { kind: "ok", board: board.board };
  return {
    kind: "foreign",
    reason: `project '${project.id}' is bound to ${project.repo.fullName}, not to the board's repo ${board.board.repo}`,
  };
}
