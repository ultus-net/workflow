import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure surface resolution for the `workflow` launcher selector
 * (docs/ideas/hub-control-plane.md MVP). No process side effects — the
 * executable selector lives in `src/cli/workflow.ts` and imports from here,
 * keeping the picker testable without spawning anything.
 */

export type LauncherVerb = "web" | "tui" | "settings" | "hub";

export const LAUNCHER_OPTIONS: readonly { readonly verb: LauncherVerb; readonly label: string }[] = [
  { verb: "web", label: "web — browser operator UI (+ settings tab)" },
  { verb: "tui", label: "tui — official opencode TUI via the hub gateway" },
  { verb: "settings", label: "settings — settings panel only" },
  { verb: "hub", label: "hub — hub daemon only (no display)" },
];

/** Subcommand-first contract: argv[0] is the surface verb when bare. */
export function parseLauncherArgs(argv: readonly string[]): { verb?: LauncherVerb; rest: readonly string[] } {
  const verb = argv[0];
  if (verb === undefined || verb.startsWith("-")) return { rest: argv };
  if (verb !== "web" && verb !== "tui" && verb !== "settings" && verb !== "hub") {
    throw new TypeError(`unknown surface '${verb}' (expected web | tui | settings | hub)`);
  }
  return { verb, rest: argv.slice(1) };
}

/** Maps picker input (number or verb) to a surface; `undefined` = unparseable. */
export function resolveSelection(input: string): LauncherVerb | undefined {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return undefined;
  const byIndex: readonly LauncherVerb[] = ["web", "tui", "settings", "hub"];
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= byIndex.length) return byIndex[numeric - 1]!;
  return byIndex.find((verb) => verb === trimmed);
}

/**
 * Resolves a sibling CLI script next to the launcher: compiled dist in an
 * installed tree, the TS source plus the tsx loader in a checkout.
 */
export function cliSibling(importUrl: string, stem: string): { script: string; execArgv: readonly string[] } {
  const here = fileURLToPath(importUrl);
  if (here.includes("/src/cli/")) {
    return { script: join(dirname(here), `${stem}.ts`), execArgv: ["--import", "tsx"] };
  }
  return { script: join(dirname(here), `${stem}.js`), execArgv: [] };
}
