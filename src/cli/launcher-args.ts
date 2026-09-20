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

/** The engine axis: which ACP agent kind every surface composes. Kept as a
 * literal union here (mirroring `AcpAgentKind` in acp-runtime and `WebAgentId`
 * in web-agents — the established pattern) so this module stays import-free. */
export type LauncherAgentKind = "opencode" | "cline" | "goose";

const LAUNCHER_AGENT_KINDS: readonly LauncherAgentKind[] = ["opencode", "cline", "goose"];

function isLauncherAgentKind(value: string): value is LauncherAgentKind {
  return (LAUNCHER_AGENT_KINDS as readonly string[]).includes(value);
}

export interface ParsedAgentFlag {
  /** The explicitly requested engine; `undefined` = leave the env default. */
  readonly agent?: LauncherAgentKind;
  /** argv with the flag removed so downstream parsers never see it. */
  readonly rest: readonly string[];
  /** Set when the flag is malformed or the kind is unknown — fail closed. */
  readonly error?: string;
}

/** Extracts `--agent <kind>` / `--agent=<kind>`; unknown values fail closed
 * with the valid list rather than being passed through to a child process. */
export function parseAgentFlag(rest: readonly string[]): ParsedAgentFlag {
  let agent: LauncherAgentKind | undefined;
  const remainder: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index]!;
    if (entry === "--agent") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { rest, error: "--agent needs a value (opencode | goose | cline)" };
      }
      if (!isLauncherAgentKind(value)) {
        return { rest, error: `unknown agent '${value}' (expected opencode | goose | cline)` };
      }
      agent = value;
      index += 1;
      continue;
    }
    if (entry.startsWith("--agent=")) {
      const value = entry.slice("--agent=".length);
      if (!isLauncherAgentKind(value)) {
        return { rest, error: `unknown agent '${value}' (expected opencode | goose | cline)` };
      }
      agent = value;
      continue;
    }
    remainder.push(entry);
  }
  return { ...(agent === undefined ? {} : { agent }), rest: remainder };
}

/** Precedence: an explicit `--agent` beats the ambient env; an unparseable
 * env value returns `undefined` here and stays the runtime's fail-closed
 * problem (`acpAgentKind` throws on invalid `WORKFLOW_ACP_AGENT`). */
export function resolveAgentKind(flag?: LauncherAgentKind, envValue?: string): LauncherAgentKind | undefined {
  if (flag !== undefined) return flag;
  const raw = envValue?.trim();
  return raw !== undefined && raw !== "" && isLauncherAgentKind(raw) ? raw : undefined;
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
