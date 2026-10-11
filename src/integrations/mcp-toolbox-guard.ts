import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { normalizeMcpEvidence, type McpCapability, type McpProvider } from "../adapters/mcp.js";
import type { Evidence } from "../kernel/contracts.js";
import { checkPolicy, type GuardCheckInput, type GuardDecision } from "./guard-policy/index.js";

/**
 * C2 (mcp-toolbox → control-plane conversion): the guard policy core runs
 * IN-PROCESS from `src/integrations/guard-policy/` (a drift-guarded,
 * byte-identical copy of the vendored app's policy source). The enforcement
 * seat no longer spawns a `workflow-guard-mcp` child, handshakes over stdio,
 * or executes a possibly-stale `dist` — the SAME `checkPolicy` the vendored
 * app runs is statically linked here. MCP remains capability and observation
 * plumbing; Workflow's kernel owns task state. The vendored app is still built
 * and mounted as an agent-facing MCP tool (see `toolboxCatalogMounts`); its
 * dist-freshness helpers below stay in use for that mount.
 */

export type { GuardCheckInput, GuardDecision } from "./guard-policy/index.js";

export interface GuardStatus {
  mode: string;
  enforcement: string;
  executesActions: boolean;
}

export interface WorkflowGuardProvider extends McpProvider {
  guardCheck(input: GuardCheckInput): Promise<GuardDecision>;
  guardStatus(): Promise<GuardStatus>;
  close(): Promise<void>;
}

/**
 * The full status payload the vendored app's `guard_status` returns,
 * reproduced verbatim so the in-process seat and the mounted MCP tool answer
 * identically (the mounted app streams it as a text content block; see
 * `mcp-toolbox/apps/workflow-guard-mcp/src/server.ts`). The public
 * `GuardStatus` type stays the minimal pre-C2 shape — no in-process consumer
 * reads the advisory fields — but the object carries all of them.
 */
const GUARD_STATUS = {
  mode: "policy-advisor",
  enforcement: "host-dependent",
  executesActions: false,
  preconditions: {
    // W084 (upstream cd2448e evaluation): the vendored policy has no todo
    // gate, and hosts without a todo tool (OpenCode v2 removed native
    // todowrite) can never satisfy one — the advisory text must not claim a
    // precondition the policy does not enforce and the host cannot provide.
    modifications: "Keep an active task or step in the host's tracking surface where one exists (todo/task tools); where the host has none (e.g. OpenCode v2 removed native todowrite), track steps through the host's available ledger instead. Edits on main/master are blocked, and the files you will change must be read in the current session.",
    finalization: "Marking every task completed triggers the finalization gate - fresh verification evidence (test run) is required after the last mutation, and protected-branch/conflict checks apply.",
  },
  circuitBreaker: {
    threshold: 2,
    guidance: "Repeated failures detected in this session. Stop attempting alternative workarounds or shell laundering. Address the required step above directly.",
  },
  recommendedActions: [
    "Before modifying files, ensure an active task exists, work on a feature branch, and read the existing files you will change.",
    "After the final mutation, run fresh verification before marking all work complete.",
    "Before finalizing or handing off changed work, inspect current review and verification accountability when those MCP products are available.",
    "If a policy denies an action, satisfy the stated precondition directly instead of trying alternate command forms.",
  ],
};

export async function createWorkflowGuardMcpProvider(options: {
  workspace?: string;
  /** W090: facts supplier enriching workspace-carrying guarded calls. Defaults to `createGuardFactsResolver()`. */
  facts?: GuardFactsResolver;
} = {}): Promise<WorkflowGuardProvider> {
  const factsResolver = options.facts ?? createGuardFactsResolver();
  const capabilities: readonly McpCapability[] = [{ name: "guard_check" }, { name: "guard_status" }];

  const guardStatus = async (): Promise<GuardStatus> => GUARD_STATUS;

  const guardCheck = async (input: GuardCheckInput): Promise<GuardDecision> => {
    // Enrichment is strictly input-workspace-driven: the four
    // workspace-carrying seats set `workspaceRoot`, so facts describe the
    // workspace the call is actually about. Calls without a workspace (the
    // containment seat — its sandbox is the boundary) enrich nothing; an
    // `options.workspace` fallback here would bind branch facts to the hub
    // root while executing in a per-call cwd — a false deny/allow vector.
    let checked = input;
    if (input.workspaceRoot !== undefined && (input.action === "shell" || input.action === "git" || input.action === "file_write") && (input.currentBranch === undefined || input.protectedBranches === undefined || input.liveConfigPaths === undefined)) {
      const facts = await factsResolver(input.workspaceRoot);
      checked = {
        ...input,
        ...(input.currentBranch === undefined && facts.currentBranch !== undefined ? { currentBranch: facts.currentBranch } : {}),
        ...(input.protectedBranches === undefined && facts.protectedBranches !== undefined ? { protectedBranches: [...facts.protectedBranches] } : {}),
        ...(input.liveConfigPaths === undefined && facts.liveConfigPaths !== undefined ? { liveConfigPaths: [...facts.liveConfigPaths] } : {}),
      };
    }
    return checkPolicy(checked);
  };

  return {
    async capabilities(): Promise<readonly McpCapability[]> {
      return capabilities;
    },
    async invoke(capability: string, input: unknown): Promise<unknown> {
      if (capability === "guard_check") return guardCheck((input ?? {}) as GuardCheckInput);
      if (capability === "guard_status") return guardStatus();
      throw new Error(`workflow-guard provider has no capability '${capability}'`);
    },
    guardCheck,
    guardStatus,
    // In-process: there is no child to reap. Kept so callers' teardown stays
    // uniform.
    close: async () => {},
  };
}

/** Resolves the vendored workflow-guard-mcp server entrypoint, building first if needed. */
export function defaultToolboxGuardServerPath(options: { root?: string } = {}): string {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const serverPath = resolve(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js");
  if (!existsSync(serverPath)) {
    throw new Error(`workflow-guard-mcp is not built; run: npm run toolbox:build (expected ${serverPath})`);
  }
  if (guardDistIsStale(root)) {
    const newest = guardDistNewestSrc(root);
    throw new Error(
      `workflow-guard-mcp dist is stale relative to its src (dist server.js mtime ${statSync(serverPath).mtimeMs} < newest src ${newest?.path} mtime ${newest?.mtimeMs}); ` +
      "run: npm run toolbox:build — the enforcement seat must not execute pre-change policy",
    );
  }
  return serverPath;
}

/** W120: the newest src file under the vendored app (for the staleness
 * message's actionable detail). Undefined when the src dir is absent. */
export function guardDistNewestSrc(root: string): { readonly path: string; readonly mtimeMs: number } | undefined {
  const appDir = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp");
  const srcDir = join(appDir, "src");
  if (!existsSync(srcDir)) return undefined;
  let newest: { readonly path: string; readonly mtimeMs: number } | undefined;
  const stack = [srcDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      const mtimeMs = statSync(path).mtimeMs;
      if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    }
  }
  return newest;
}

/** W120 (the W097-queued dist-freshness gate; LESS-0010's hazard): the
 * vendored-guard dist is STALE when any file under the app's src/ has a
 * newer mtime than dist/server.js. existsSync alone let hub-side tests run
 * a stale seat executing pre-change policy. A missing dist is NOT staleness
 * — that is the separate not-built error's job. The mtime comparison has a
 * known false-positive class (git checkout touches mtimes without content
 * change) — the fail-closed direction is deliberate: the remedy (rebuild)
 * is deterministic and idempotent. A missing SRC dir also returns false
 * (degenerate layout; the not-built error governs the missing-dist case,
 * and `guardDistNewestSrc` exposes the newest-src detail for the staleness
 * message). */
export function guardDistIsStale(root: string): boolean {
  const appDir = join(root, "mcp-toolbox", "apps", "workflow-guard-mcp");
  const serverPath = join(appDir, "dist", "server.js");
  if (!existsSync(serverPath)) return false;
  const distMtime = statSync(serverPath).mtimeMs;
  const srcDir = join(appDir, "src");
  if (!existsSync(srcDir)) return false;
  const stack = [srcDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (statSync(path).mtimeMs > distMtime) return true;
    }
  }
  return false;
}

export function createDefaultToolboxGuardProvider(options: {
  workspace?: string;
} = {}): Promise<WorkflowGuardProvider> {
  return createWorkflowGuardMcpProvider(options);
}

export function guardPolicyEvidence(decision: GuardDecision, mutationEpoch: number): Evidence {
  return normalizeMcpEvidence(
    {
      observationId: `guard:${decision.policy}`,
      subject: `policy:${decision.policy}`,
      result: decision.decision === "allow" ? "passed" : "failed",
      observedAt: new Date().toISOString(),
    },
    mutationEpoch,
  );
}

// W090 (frontier G2, part 1): the hub seat supplies workspace-derivable facts
// to the vendored guard. `guardInputFromToolCall` is pure, so the facts live at
// the provider boundary: every guarded shell/git/file_write call that carries a
// workspace is enriched with the current branch, the protected-branch default,
// and the live runtime-config root. Caller-supplied facts always win;
// undiscoverable facts are omitted (fail-open to the fact-less behavior, never
// guessed). `trustedRole` is deliberately NOT supplied here — seat-level role
// semantics are a separate design decision (queued).

export interface GuardFacts {
  currentBranch?: string;
  protectedBranches?: readonly string[];
  liveConfigPaths?: readonly string[];
}

export type GuardFactsResolver = (workspaceRoot: string) => Promise<GuardFacts>;

/**
 * Hub default, mirroring the vendored plugin's default project config; a
 * configured source is follow-up work. Today the fact is inert
 * future-proofing — the vendored git-policy hard-codes main/master when the
 * fact is absent — but supplying it keeps the seat contract ready for a
 * configured source.
 */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

export interface GuardFactsResolverOptions {
  /** HOME used to derive the runtime-config root; tests inject a temp dir. */
  homeDir?: string;
  /** Git runner seam; tests inject failures or stubs. Default: read-only `git` exec. */
  runGit?: (args: readonly string[], cwd: string) => Promise<string>;
}

export function createGuardFactsResolver(options: GuardFactsResolverOptions = {}): GuardFactsResolver {
  const home = options.homeDir ?? homedir();
  const runGit = options.runGit ?? (async (args: readonly string[], cwd: string): Promise<string> => {
    const exec = promisify(execFile);
    const { stdout } = await exec("git", [...args], { cwd, encoding: "utf8" });
    return stdout;
  });
  const runtimeConfigRoot = join(home, ".config", "opencode");
  return async (workspaceRoot: string): Promise<GuardFacts> => {
    let currentBranch: string | undefined;
    try {
      currentBranch = (await runGit(["branch", "--show-current"], workspaceRoot)).trim() || undefined;
    } catch {
      currentBranch = undefined;
    }
    // A nonexistent root is not a live root: declaring one would claim
    // consumption that does not exist. Existing-and-absolute is usable, so the
    // vendored normalizeLiveRoots accepts the set.
    const liveConfigPaths = existsSync(runtimeConfigRoot) ? [runtimeConfigRoot] : undefined;
    return {
      ...(currentBranch !== undefined ? { currentBranch } : {}),
      protectedBranches: DEFAULT_PROTECTED_BRANCHES,
      ...(liveConfigPaths !== undefined ? { liveConfigPaths } : {}),
    };
  };
}

// Plan Task G2: one shared tool-call → guard-input mapping, used by the
// Cline plugin (/before-tool route), the ACP permission resolver, and the
// OpenCode plugin, so every surface gets identical policy decisions from the
// guard dispatcher. Tool-name families cover the Cline hook surface, the ACP
// approval surface (run_commands, replace_in_file, delete_file, ...), and the
// OpenCode tool surface (edit, write, patch, bash, webfetch).
const SHELL_TOOLS = new Set(["execute_command", "bash", "run_commands", "shell"]);
const FILE_WRITE_TOOLS = new Set([
  "write_to_file",
  "new_file_template",
  "write_file",
  "editor",
  "replace_in_file",
  "edit",
  "write",
  // The hub-implemented ACP fs server (agents that delegate file operations
  // to the client — OpenCode `--pure`): a delegated write must hit the same
  // guard policy as a direct one.
  "fs/write_text_file",
]);
const PATCH_TOOLS = new Set(["apply_patch", "patch"]);
const DELETE_TOOLS = new Set(["delete_file"]);
const NETWORK_TOOLS = new Set(["webfetch", "web_fetch", "fetch_web_content", "websearch", "web_search"]);

export function guardInputFromToolCall(toolName: string, input: unknown, workspaceRoot?: string): GuardCheckInput | undefined {
  const base = workspaceRoot === undefined ? {} : { workspaceRoot };
  if (SHELL_TOOLS.has(toolName)) {
    return { action: "shell", command: shellCommandFromInput(input), ...base };
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    // Extraction keys cover every host's shapes: path/filePath/file_path,
    // content/newString — content-bearing edits must never reach the guard
    // path- or content-blind.
    const path = firstString(record, ["path", "filePath", "file_path"]);
    const content = firstString(record, ["content", "newString"]);
    const patchText = firstString(record, ["patchText", "patch", "diff"]);
    return {
      action: "file_write",
      ...(path === undefined ? {} : { path }),
      ...(content === undefined ? {} : { content }),
      ...(patchText === undefined ? {} : { patchText }),
      ...base,
    };
  }
  if (PATCH_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    const path = firstString(record, ["path", "filePath", "file_path"]);
    const patchText = firstString(record, ["patchText", "patch", "diff"]);
    return {
      action: "file_write",
      ...(path === undefined ? {} : { path }),
      ...(patchText === undefined ? {} : { patchText }),
      ...base,
    };
  }
  if (DELETE_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    const path = firstString(record, ["path", "filePath", "file_path"]);
    return {
      action: "file_write",
      ...(path === undefined ? {} : { path }),
      ...base,
    };
  }
  if (NETWORK_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    const url = firstString(record, ["url", "input"]);
    return {
      action: "network",
      ...(url === undefined ? {} : { command: url }),
      ...base,
    };
  }
  return undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function inputRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return input as Record<string, unknown>;
}

function shellCommandFromInput(input: unknown): string {
  if (typeof input === "string") return input;
  const record = inputRecord(input);
  if (record === undefined) return "";
  if (typeof record.command === "string") return record.command;
  if (record.command !== null && typeof record.command === "object") {
    const structured = record.command as { command?: string; args?: string[] };
    return [structured.command, ...(structured.args ?? [])].filter(Boolean).join(" ");
  }
  if (Array.isArray(record.commands)) {
    return record.commands
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry !== null && typeof entry === "object") {
          const structured = entry as { command?: string; args?: string[] };
          return [structured.command, ...(structured.args ?? [])].filter(Boolean).join(" ");
        }
        return "";
      })
      .filter((command) => command.length > 0)
      .join("; ");
  }
  return "";
}
