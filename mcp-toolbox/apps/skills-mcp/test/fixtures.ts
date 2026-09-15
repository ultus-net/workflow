import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The fixture skills directory (also usable as an env-configured server root). */
export const fixtureSkillsDir = resolve(import.meta.dirname, "fixtures", "skills");

/** A malformed level map for the fail-closed test. */
export function malformedMapDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-bad-map-"));
  writeFileSync(join(dir, "levels.json"), "{ not json", "utf8");
  return dir;
}