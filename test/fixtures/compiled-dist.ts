/**
 * The shared compiled-artifact freshness gate (W125, generalized in W126/W127):
 * W120's staleness semantics scoped to a WHOLE-src walk — the remedy
 * (`npm run build`) rebuilds the entire dist, so all-of-src IS the remedy's
 * true input graph; a walk narrower than what the remedy consumes is the
 * LESS-0049(4) lie (the W125 rounds' P2s). A missing artifact is the
 * rebuild's job, never "staleness" (W120's two-error-class split). The
 * build's config inputs ride the same comparison. The mtime false-positive
 * class (a checkout touching mtimes without a content change) is W120's
 * recorded, deliberate fail-closed trade — the rebuild is idempotent.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = process.cwd();

/** Newest mtime under the src tree, or undefined when the tree is absent. */
function newestSrcMtime(srcRoot: string): number | undefined {
  if (!existsSync(srcRoot)) return undefined;
  let newest: number | undefined;
  const stack = [srcRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      const mtimeMs = statSync(path).mtimeMs;
      if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
    }
  }
  return newest;
}

const BUILD_CONFIG_INPUTS = [
  "tsconfig.json",
  "tsconfig.build.json",
  "package.json",
  "package-lock.json",
  // The prebuilt webapp bundle's emitter (W127): a script-only edit must
  // rebuild too, or the packaged seat serves stale prebuilt content (the
  // round-3 review's P3 — the gate walked only src + the tsconfig/manifest
  // inputs, and the prebuilt emit lives in scripts/).
  join("scripts", "build-webapp-bundle.mjs"),
] as const;

/** A missing artifact is NOT staleness; any src file or build-config input
 * newer than the artifact is stale (fail-closed: the remedy is a rebuild). */
export function artifactIsStale(artifact: string): boolean {
  if (!existsSync(artifact)) return false;
  const artifactMtime = statSync(artifact).mtimeMs;
  const newest = newestSrcMtime(join(repoRoot, "src"));
  if (newest !== undefined && newest > artifactMtime) return true;
  return BUILD_CONFIG_INPUTS.some((name) => {
    const path = join(repoRoot, name);
    return existsSync(path) && statSync(path).mtimeMs > artifactMtime;
  });
}

/** Rebuild via the recorded remedy when the artifact is missing or stale. */
export function ensureFresh(artifact: string): void {
  if (existsSync(artifact) && !artifactIsStale(artifact)) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
}

/** A compiled bin's artifact path (dist/cli/<name>). */
export function distArtifact(...parts: readonly string[]): string {
  return join(repoRoot, "dist", ...parts);
}