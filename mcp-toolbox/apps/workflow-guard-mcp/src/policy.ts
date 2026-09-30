import { basename } from "node:path";
import { checkShellPolicy } from "./shell-policy.js";
import { checkProtectedPath, secretIn } from "./path-policy.js";
import { decodeShellEscapes, splitShellSegments, unwrapShellWords } from "./shell.js";
import { checkGitPolicy, directRefWriteTargetIn, hasGitMutation, protectedBranchesIn, protectedBranchWriteReason } from "./git-policy.js";
import { checkInterpreterPolicy } from "./interpreter-policy.js";
import { checkBoundaryPolicy, isGuardConfigurationPath, isPathOutsideWorkspace, shellHasFileMutation } from "./boundary-policy.js";
import { mcpMutationTarget } from "./mcp-policy.js";
import { checkPrCreatePreflight } from "./pr-policy.js";
import { redirectGuidance } from "./redirect.js";

export type GuardAction = "shell" | "file_write" | "git" | "network" | "mcp";

export interface GuardCheckInput {
  action: GuardAction;
  command?: string;
  path?: string;
  workspaceRoot?: string;
  /**
   * Host-supplied absolute paths of the LIVE control plane (e.g. the runtime
   * `~/.config/opencode`, the guard's own install/source). When present, the
   * guard-tamper rule classifies by these runtime-consumption facts instead of
   * filename segments: only mutations under a declared live root are denied
   * (T0); config-shaped drafts elsewhere — dotfiles `.config/opencode`,
   * worktrees — are allowed (T2). Absent => fail-closed segment matching,
   * unchanged.
   */
  liveConfigPaths?: string[];
  content?: string;
  patchText?: string;
  currentBranch?: string;
  protectedBranches?: string[];
  trustedRole?: string;
  toolName?: string;
  failureCount?: number;
}

export interface GuardDecision {
  decision: "allow" | "deny" | "ask";
  policy: string;
  reason: string;
  /** W121 (G4, the F6 residual): the concrete surface the rule matched —
   * the offending path/command/toolName. Absent when the rule keyed on no
   * concrete surface (allows, the promotion-gate/network asks) — never
   * fabricated. */
  matched?: string;
}

export const CIRCUIT_BREAKER_GUIDANCE =
  "\n\n[Workflow Guard Circuit Breaker: Repeated failures detected in this session. Stop attempting alternative workarounds or shell laundering. Address the required step above directly.]";

const READ_ONLY_ROLES = new Set(["reviewer", "planner", "advisor", "critic", "explorer", "scout", "evaluator"]);

export function isReadOnlyRole(role?: string): boolean {
  if (!role) return false;
  const normalized = role.toLowerCase().trim();
  return READ_ONLY_ROLES.has(normalized) || [...READ_ONLY_ROLES].some((candidate) => normalized.includes(candidate));
}

export function extractPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const match of patchText.matchAll(/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to|Move from):\s*(.+?)\s*$/gm)) {
    if (match[1]) paths.push(match[1]);
  }
  for (const match of patchText.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(\S+)/gm)) {
    if (match[1] && match[1] !== "/dev/null") paths.push(match[1]);
  }
  return paths;
}

// W091 (frontier G3 part 1): `workflow install` deploys the vendored fleet
// payload into the live control plane — the sanctioned T1 promotion command.
// Upstream's guard-invisibility finding: from an agent seat it was
// baseline-allow while the equivalent `cp` into a live root is
// guard-tamper-denied. The T1 tier says promotion is an ASK (operator
// approval), never agent-auto-allow. Recognition is command-position based
// (post-unwrap), like the interactive detector's command-position matching —
// a promotion-shaped phrase in argument data (`echo workflow install`) is
// not execution. Documented limitation (the T1 gate covers the sanctioned
// shape only): indirection (`npx workflow install`), nested shells and eval
// (`sh -c 'workflow install fleet'` — the recognizer does not recurse, unlike
// the interactive detector), and case variants (`Workflow install` — on
// Linux a different binary name) are NOT recognized. For those forms the
// promotion is unguarded AT THE SHELL LANE; the T0 backstop covers only the
// agent performing equivalent writes DIRECTLY (a `cp`/redirect into a
// declared live root is guard-tamper-denied in W090 fact mode) — the
// installer's own in-process writes are tool-invisible to the guard.
const PROMOTION_REASON =
  "Installing into the live control plane requires operator approval (T1 promotion): run it from the operator's shell.";

function isPromotionCommand(command: string): boolean {
  return splitShellSegments(decodeShellEscapes(command)).some((segment) => {
    const words = unwrapShellWords(segment);
    return basename(words[0] ?? "") === "workflow" && words[1] === "install";
  });
}

export function checkPolicy(input: GuardCheckInput): GuardDecision {
  const result = evaluatePolicy(input);
  if (result.decision !== "deny") return result;
  // W070b slice 4a: every denial carries a short, imperative redirect naming
  // the expected tool class; the circuit breaker stays appended on repeat
  // failures. Denial UX only — the decision is unchanged.
  let reason = `${result.reason} ${redirectGuidance(result.policy)}`;
  if (typeof input.failureCount === "number" && input.failureCount >= 2) {
    reason += CIRCUIT_BREAKER_GUIDANCE;
  }
  return { ...result, reason };
}

function evaluatePolicy(input: GuardCheckInput): GuardDecision {
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const boundary = checkBoundaryPolicy(input.command, input.workspaceRoot, 0, input.liveConfigPaths, { currentBranch: input.currentBranch, protectedBranches: input.protectedBranches });
    if (boundary) return boundary;
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const interpreter = checkInterpreterPolicy(input.command, input.workspaceRoot, input.liveConfigPaths);
    if (interpreter) return interpreter;
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const git = checkGitPolicy(input.command, { currentBranch: input.currentBranch, protectedBranches: input.protectedBranches });
    if (git) return git;
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const shell = checkShellPolicy(input.command, { currentBranch: input.currentBranch, protectedBranches: input.protectedBranches });
    if (shell) return shell;
  }
  // W091 ordering: the promotion ask is evaluated AFTER the deny-class
  // policies, so a compound command whose other segment is a deny (e.g. a
  // destructive operation) reports that deny instead of masking it behind
  // the ask (reason attribution; the pinned compound test).
  if ((input.action === "shell" || input.action === "git") && input.command?.trim() && isPromotionCommand(input.command)) {
    return { decision: "ask", policy: "promotion-gate", reason: PROMOTION_REASON };
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const pr = checkPrCreatePreflight(input.command);
    if (pr) return pr;
  }

  if (isReadOnlyRole(input.trustedRole)) {
    if (input.action === "git" && input.command?.trim() && hasGitMutation(input.command)) {
      return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot mutate Git state.`, matched: input.command };
    }
    if (input.action === "shell" && input.command?.trim()) {
      if (shellHasFileMutation(input.command)) return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot perform shell file mutations.`, matched: input.command };
      if (hasGitMutation(input.command)) return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot mutate Git state.`, matched: input.command };
    }
  }

  const paths = [input.path?.trim() ?? "", ...(input.action === "file_write" && input.patchText ? extractPatchPaths(input.patchText) : [])].filter(Boolean);

  for (const path of paths) {
    // Upstream precedence (edit/write handler): the guard-tamper
    // classification runs BEFORE the system/secret checks, so a
    // config-shaped path is reported as guard-tamper even where a realpath
    // would also match a system rule (e.g. ostree hosts where /home
    // resolves under /var).
    if (input.action === "file_write" && isGuardConfigurationPath(path, input.workspaceRoot, input.liveConfigPaths)) {
      return { decision: "deny", policy: "guard-tamper", reason: "Writing host or workflow-guard configuration from the agent is not allowed.", matched: path };
    }
    const protectedReason = checkProtectedPath(path, input.workspaceRoot);
    if (protectedReason) {
      return {
        decision: "deny",
        policy: "protected-path",
        reason: protectedReason,
        matched: path,
      };
    }
    if (input.action === "file_write" && input.patchText && input.workspaceRoot && isPathOutsideWorkspace(path, input.workspaceRoot)) {
      return { decision: "deny", policy: "workspace-boundary", reason: `Patch target '${path}' is outside workspace '${input.workspaceRoot}'.`, matched: path };
    }
    // P18 (c): the file_write lane reaches the SAME protected-target gate a
    // direct `.git/` ref path would through a shell write.
    if (input.action === "file_write") {
      const refWrite = directRefWriteTargetIn(path);
      if (refWrite) {
        if (refWrite.uncertain) return { decision: "deny", policy: "protected-branch-write", reason: `Direct .git ref-adjacent write '${path}' could not be resolved to a concrete branch; failing closed.`, matched: path };
        if (refWrite.target && protectedBranchesIn({ currentBranch: input.currentBranch, protectedBranches: input.protectedBranches }).has(refWrite.target)) {
          return { decision: "deny", policy: "protected-branch-write", reason: `Direct .git branch-pointer writes on protected branch '${refWrite.target}' are not allowed.`, matched: path };
        }
      }
    }
  }

  if (input.action === "file_write" && input.content) {
    const secret = secretIn(input.content);
    if (secret) return { decision: "deny", policy: "secret-content", reason: `The proposed content contains ${secret}.` };
  }

  if (input.action === "file_write") {
    const branchReason = protectedBranchWriteReason({ currentBranch: input.currentBranch, protectedBranches: input.protectedBranches });
    if (branchReason) return { decision: "deny", policy: "protected-branch-write", reason: branchReason, ...(input.path === undefined ? {} : { matched: input.path }) };
    if (isReadOnlyRole(input.trustedRole)) return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot perform file mutations.`, ...(input.path === undefined ? {} : { matched: input.path }) };
  }

  if (input.action === "network") {
    return {
      decision: "ask",
      policy: "external-side-effect",
      reason: "External side effects should require explicit user approval.",
    };
  }

  if (input.action === "mcp" && input.toolName) {
    const target = mcpMutationTarget(input.toolName);
    if (target) return { decision: "deny", policy: "live-mcp-mutation", reason: `${input.toolName} mutates ${target}, a live system.`, matched: input.toolName };
  }

  return {
    decision: "allow",
    policy: "baseline",
    reason: "No baseline high-risk policy matched the proposed action.",
  };
}
