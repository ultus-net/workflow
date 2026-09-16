/**
 * Types for scripts/vendor-skills.mjs — a hand-maintained declaration so the
 * implementation stays plain-runnable with `node scripts/vendor-skills.mjs`
 * while tests import it with full types. Keep in sync with the .mjs exports.
 */

/** A source to vendor from: a git repository or a local directory. */
export interface VendorSource {
  readonly name: string;
  readonly repo?: string;
  readonly path?: string;
  readonly include: readonly string[];
}

/** A discovered skill directory: the directory name is the skill name. */
export interface SkillCandidate {
  readonly name: string;
  readonly dir: string;
  readonly description: string | undefined;
}

export interface NameReason {
  readonly name: string;
  readonly reason: string;
}

export interface ImportReport {
  readonly imported: readonly string[];
  readonly updated: readonly string[];
  readonly refused: readonly NameReason[];
  readonly skipped: readonly NameReason[];
  readonly pruned: readonly string[];
  readonly archived: readonly string[];
  readonly problems: readonly string[];
}

export interface ProvenanceRecord {
  readonly source: string;
  readonly originPath: string;
  readonly commit?: string;
}

export type ProvenanceMap = Readonly<Record<string, ProvenanceRecord>>;

export interface ImportOptions {
  readonly skillsDir: string;
  readonly sources: readonly VendorSource[];
  readonly prune?: boolean;
  readonly archive?: boolean;
  readonly dryRun?: boolean;
  /** Injectable shallow-clone for tests; returns the cloned HEAD commit. */
  readonly clone?: (repo: string, dest: string) => Promise<string>;
}

export const PROVENANCE_FILE: string;
export const DEFAULT_SOURCES: readonly VendorSource[];

export function resolveSkillsDir(explicit?: string): string;
export function listSkillCandidates(
  sourceRoot: string,
  include: readonly string[],
): { readonly candidates: readonly SkillCandidate[]; readonly problems: readonly string[] };
export function loadProvenance(skillsDir: string): ProvenanceMap;
export function importSkills(options: ImportOptions): Promise<ImportReport>;