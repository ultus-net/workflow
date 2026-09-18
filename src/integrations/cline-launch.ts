import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves which Cline agent the ACP driver should launch.
 *
 * Precedence:
 * 1. WORKFLOW_CLINE_BIN env override (a compiled Cline binary path).
 * 2. The ambient `cline` on PATH — stock `cline --acp` run through Node and its
 *    `bin/cline` wrapper. Per the W050 operator scope decision the retained
 *    connector is stock-only; headless auth is the stock CLI's own
 *    `CLINE_API_KEY` / `CLINE_PROVIDER` path.
 * 3. DEPRECATED fallback: the vendored, Workflow-patched checkout's compiled
 *    binary (`.workflow-cline/cline/apps/cli/dist/cli-<os>-<arch>/bin/cline`).
 *    This branch exists only until W050 step 6 deletes the vendored checkout;
 *    do not build new behavior on it.
 *
 * Compiled binaries are self-contained (Bun-embedded) and run directly as the
 * executable. The PATH entry keeps the historical launch shape: Node running
 * the wrapper script, which resolves its own platform binary.
 */
export interface ClineLaunchResolution {
  /** Agent executable: the Node binary or a self-contained compiled agent. */
  readonly executable: string;
  /** Agent entry script for the executable; undefined for compiled agents. */
  readonly script?: string | undefined;
}

export interface ClineLaunchInput {
  /** Workflow repository root (contains `.workflow-cline`; deprecated fallback only). */
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

  if (input.clineOnPath !== undefined) {
    return { executable: process.execPath, script: input.clineOnPath };
  }

  // DEPRECATED (W050 step 6 removes the vendored checkout): last-resort fallback.
  if (exists(compiled)) {
    return { executable: realpath(compiled) };
  }

  throw new Error(
    "No Cline agent available: install the cline CLI globally (stock `cline --acp`) or set WORKFLOW_CLINE_BIN to a compiled binary",
  );
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
