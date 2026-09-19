import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from this module to the directory that owns pnpm-workspace.yaml. */
export function findWorkspaceRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`could not locate mcp-toolbox workspace root from ${start}`);
    current = parent;
  }
}

export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

export function readPackageManifest(appDir: string): PackageManifest {
  const raw = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as Partial<PackageManifest>;
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${appDir}/package.json is missing name/version`);
  }
  return raw.description === undefined
    ? { name: raw.name, version: raw.version }
    : { name: raw.name, version: raw.version, description: raw.description };
}

/** A copy of process.env with undefined values removed (stdio env typing). */
export function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...overrides };
}