import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Server-side bounded file mutations (plan Task G3). The hub authorized the
 * call; these operations enforce the workspace bound locally as defense in
 * depth — including symlink-ancestor resolution, because lexical or
 * final-path-only checks are known bypass shapes (ported from the plugin's
 * adversarial corpus).
 */

export function resolveWithinWorkspace(workspace: string, target: string): string {
  if (!isAbsolute(workspace)) throw new Error(`workspace must be absolute: '${workspace}'`);
  if (target.length === 0) throw new Error("path must not be empty");
  const canonicalWorkspace = realpathSync(workspace);
  const anchored = isAbsolute(target) ? target : resolve(canonicalWorkspace, target);
  // Lexical bound: resolve() has already folded away any ".." segments.
  if (anchored === canonicalWorkspace) throw new Error("path must name a file, not the workspace root");
  if (!anchored.startsWith(canonicalWorkspace + sep)) {
    throw new Error(`path '${target}' resolves outside the workspace`);
  }
  // Symlink bound. lstat (never follows links) finds the deepest existing
  // path so a DANGLING final symlink cannot hide: existsSync would treat it
  // as nonexistent, and writeFileSync would follow it outside the workspace
  // (the corpus's known bypass). realpathSync then resolves every existing
  // segment — throwing on dangling links — and any resolution outside the
  // workspace is denied. Segments that do not exist yet cannot be symlinks.
  let probe = anchored;
  while (lstatSync(probe, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync(probe);
  } catch {
    throw new Error(`path '${target}' resolves outside the workspace (dangling symlink)`);
  }
  if (realAncestor !== canonicalWorkspace && !realAncestor.startsWith(canonicalWorkspace + sep)) {
    throw new Error(`path '${target}' resolves outside the workspace (symlinked escape)`);
  }
  // If the final path itself exists as a symlink, its resolution must also
  // stay inside the workspace (writeFileSync follows it on the actual write).
  if (lstatSync(anchored, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    let resolved: string;
    try {
      resolved = realpathSync(anchored);
    } catch {
      throw new Error(`path '${target}' resolves outside the workspace (dangling symlink)`);
    }
    if (resolved !== canonicalWorkspace && !resolved.startsWith(canonicalWorkspace + sep)) {
      throw new Error(`path '${target}' resolves outside the workspace (symlinked escape)`);
    }
  }
  return anchored;
}

export function applyWrite(input: { readonly workspace: string; readonly path: string; readonly content: string }): string {
  const target = resolveWithinWorkspace(input.workspace, input.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, input.content, "utf8");
  return target;
}

export function applyEdit(input: {
  readonly workspace: string;
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
}): { readonly target: string; readonly replacements: number } {
  if (input.oldString.length === 0) throw new Error("old_string must not be empty");
  const target = resolveWithinWorkspace(input.workspace, input.path);
  const content = readFileSync(target, "utf8");
  const occurrences = content.split(input.oldString).length - 1;
  if (occurrences === 0) throw new Error(`old_string not found in '${input.path}'`);
  if (occurrences > 1) throw new Error(`old_string is ambiguous in '${input.path}' (${occurrences} occurrences)`);
  writeFileSync(target, content.replace(input.oldString, input.newString), "utf8");
  return { target, replacements: 1 };
}
