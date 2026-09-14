import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Shared helpers for the gated Cline probe suites. This module is imported by
 * probe tests; it is never run as a test on its own.
 */

export function defaultClineKeyFile(): string {
  return process.env.CLINE_API_KEY_FILE ?? path.join(homedir(), ".config", "workflow", "cline-api-key");
}

/**
 * Resolves the Cline credential from the environment or the default key file,
 * throwing when unavailable so a gated probe fails rather than guessing.
 */
export async function loadClineApiKey(purpose = "Cline probe"): Promise<string> {
  if (process.env.CLINE_API_KEY) return process.env.CLINE_API_KEY;
  const key = (await readFile(defaultClineKeyFile(), "utf8")).trim();
  if (!key) throw new Error(`${purpose} requires CLINE_API_KEY or CLINE_API_KEY_FILE`);
  return key;
}

/** Resolves the installed `cline` binary to its real entry path (Bubblewrap needs realpaths). */
export function clineEntrypoint(): string {
  const bin = execFileSync("/usr/bin/which", ["cline"], { encoding: "utf8" }).trim();
  return realpathSync(bin);
}
