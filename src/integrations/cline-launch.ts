import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves which Cline agent the ACP driver should launch.
 *
 * Precedence:
 * 1. WORKFLOW_CLINE_BIN env override (a compiled Cline binary path).
 * 2. The vendored, Workflow-patched Cline checkout's compiled binary
 *    (`.workflow-cline/cline/apps/cli/dist/cli-<os>-<arch>/bin/cline`).
 * 3. The globally installed `cline` CLI (Node + its `bin/cline` wrapper).
 *
 * Compiled binaries are self-contained (Bun-embedded) and run directly as
 * the executable. The global fallback keeps the historical launch shape:
 * Node running the wrapper script, which resolves its own platform binary.
 */
export interface ClineLaunchResolution {
  /** Agent executable: the Node binary or a self-contained compiled agent. */
  readonly executable: string;
  /** Agent entry script for the executable; undefined for compiled agents. */
  readonly script?: string | undefined;
}

export interface ClineLaunchInput {
  /** Workflow repository root (contains `.workflow-cline`). */
  readonly workflowRoot: string;
  /** WORKFLOW_CLINE_BIN override; a compiled Cline binary path. */
  readonly envBinOverride?: string | undefined;
  /** Realpath-resolved global `cline` entry, or undefined when absent. */
  readonly clineOnPath?: string | undefined;
  /** Existence probe, injectable for tests. */
  readonly exists?: ((path: string) => boolean) | undefined;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: ((path: string) => string) | undefined;
}

export function resolveClineLaunch(input: ClineLaunchInput): ClineLaunchResolution {
  const exists = input.exists ?? existsSync;
  const realpath = input.realpath ?? realpathSync;
  const compiled = join(
    input.workflowRoot,
    ".workflow-cline",
    "cline",
    "apps",
    "cli",
    "dist",
    clinePlatformDir(),
    "bin",
    process.platform === "win32" ? "cline.exe" : "cline",
  );
  const override = input.envBinOverride?.trim();

  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      throw new Error(`WORKFLOW_CLINE_BIN points at a missing binary: ${override}`);
    }
    return { executable: realpath(override) };
  }

  if (exists(compiled)) {
    return { executable: realpath(compiled) };
  }

  if (input.clineOnPath === undefined) {
    throw new Error(
      "No Cline agent available: run `npm run build:cline-agent` or install the cline CLI globally",
    );
  }
  return { executable: process.execPath, script: input.clineOnPath };
}

/** Realpath-resolved global `cline` entry, or undefined when not installed. */
export function globalClineEntrypoint(): string | undefined {
  let bin: string;
  try {
    bin = execFileSync("/usr/bin/which", ["cline"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
  if (bin === "") return undefined;
  try {
    return realpathSync(bin);
  } catch {
    return undefined;
  }
}

/** Platform directory name Cline's build script uses for compiled binaries. */
function clinePlatformDir(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `cli-${os}-${process.arch}`;
}
