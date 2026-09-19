import { checkShellPolicy } from "./shell-policy.js";
import { checkProtectedPath, secretIn } from "./path-policy.js";
import { checkGitPolicy, hasGitMutation, protectedBranchWriteReason } from "./git-policy.js";
import { checkInterpreterPolicy } from "./interpreter-policy.js";
import { checkBoundaryPolicy, isPathOutsideWorkspace, shellHasFileMutation } from "./boundary-policy.js";
import { mcpMutationTarget } from "./mcp-policy.js";
import { checkPrCreatePreflight } from "./pr-policy.js";
import { redirectGuidance } from "./redirect.js";

export type GuardAction = "shell" | "file_write" | "git" | "network" | "mcp";

export interface GuardCheckInput {
  action: GuardAction;
  command?: string;
  path?: string;
  workspaceRoot?: string;
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
    const boundary = checkBoundaryPolicy(input.command, input.workspaceRoot);
    if (boundary) return boundary;
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const interpreter = checkInterpreterPolicy(input.command, input.workspaceRoot);
    if (interpreter) return interpreter;
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const git = checkGitPolicy(input.command, { currentBranch: input.currentBranch, protectedBranches: input.protectedBranches });
    if (git) return git;
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const shell = checkShellPolicy(input.command);
    if (shell) return shell;
  }
  if ((input.action === "shell" || input.action === "git") && input.command?.trim()) {
    const pr = checkPrCreatePreflight(input.command);
    if (pr) return pr;
  }

  if (isReadOnlyRole(input.trustedRole)) {
    if (input.action === "git" && input.command?.trim() && hasGitMutation(input.command)) {
      return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot mutate Git state.` };
    }
    if (input.action === "shell" && input.command?.trim()) {
      if (shellHasFileMutation(input.command)) return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot perform shell file mutations.` };
      if (hasGitMutation(input.command)) return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot mutate Git state.` };
    }
  }

  const paths = [input.path?.trim() ?? "", ...(input.action === "file_write" && input.patchText ? extractPatchPaths(input.patchText) : [])].filter(Boolean);

  for (const path of paths) {
    const protectedReason = checkProtectedPath(path, input.workspaceRoot);
    if (protectedReason) {
      return {
        decision: "deny",
        policy: "protected-path",
        reason: protectedReason,
      };
    }
    if (input.action === "file_write" && input.patchText && input.workspaceRoot && isPathOutsideWorkspace(path, input.workspaceRoot)) {
      return { decision: "deny", policy: "workspace-boundary", reason: `Patch target '${path}' is outside workspace '${input.workspaceRoot}'.` };
    }
  }

  if (input.action === "file_write" && input.content) {
    const secret = secretIn(input.content);
    if (secret) return { decision: "deny", policy: "secret-content", reason: `The proposed content contains ${secret}.` };
  }

  if (input.action === "file_write") {
    const branchReason = protectedBranchWriteReason({ currentBranch: input.currentBranch, protectedBranches: input.protectedBranches });
    if (branchReason) return { decision: "deny", policy: "protected-branch-write", reason: branchReason };
    if (isReadOnlyRole(input.trustedRole)) return { decision: "deny", policy: "read-only-role", reason: `Read-only role '${input.trustedRole}' cannot perform file mutations.` };
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
    if (target) return { decision: "deny", policy: "live-mcp-mutation", reason: `${input.toolName} mutates ${target}, a live system.` };
  }

  return {
    decision: "allow",
    policy: "baseline",
    reason: "No baseline high-risk policy matched the proposed action.",
  };
}
