import { basename } from "node:path";
import { splitShellSegments, unwrapShellWords } from "./shell.js";

const gitWriteRe = /\bgit\s+(?:add|rm|mv|commit|merge|rebase|cherry-pick|revert|stash\s+pop|apply|am|restore|reset|update-ref|filter-branch)\b|\bgit\s+tag\s+(?!--?list\b|-l\b)|\bgit\s+checkout\s+(?!-b\b)|\bgit\s+branch\s+(?:[^|;&]*\s)?-[dDM]\b/;
const gitValueOptions = new Set(["-C", "--git-dir", "--work-tree", "-c", "--config-env", "--namespace"]);
const gitBooleanOptions = new Set(["--version", "--help", "--no-pager", "-p", "--paginate", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--exec-path"]);

function normalizedGitSegments(command: string): string[] {
  return splitShellSegments(command).flatMap((segment) => {
    const words = unwrapShellWords(segment);
    if (basename(words[0] ?? "") !== "git") return [];
    let i = 1;
    while (i < words.length) {
      const option = words[i]!;
      if (gitValueOptions.has(option)) { i += 2; continue; }
      if (/^(?:--git-dir=|--work-tree=|--namespace=|-c\S|--config-env=)/.test(option) || gitBooleanOptions.has(option)) { i += 1; continue; }
      break;
    }
    return [`git ${words.slice(i).join(" ")}`];
  });
}

export interface GitPolicyContext {
  currentBranch?: string;
  protectedBranches?: string[];
}

function protectedBranchesIn(context: GitPolicyContext): Set<string> {
  return new Set(["main", "master", ...(context.protectedBranches ?? [])]);
}

export function protectedBranchWriteReason(context: GitPolicyContext): string | undefined {
  if (!context.currentBranch || !protectedBranchesIn(context).has(context.currentBranch)) return undefined;
  return `Direct changes on protected branch '${context.currentBranch}' are not allowed. Create a feature branch first.`;
}

export function hasGitMutation(command: string, depth = 0): boolean {
  if (depth >= 16) return true;
  const normalized = normalizedGitSegments(command).join(" ; ");
  if (gitWriteRe.test(normalized) || /\bgit\s+(?:switch|checkout)\b/.test(normalized)) return true;
  return splitShellSegments(command).some((segment) => {
    const words = unwrapShellWords(segment);
    if (!/^(?:ba|z|da|k)?sh$/i.test(basename(words[0] ?? ""))) return false;
    const commandFlag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    return commandFlag >= 0 && Boolean(words[commandFlag + 1]) && hasGitMutation(words[commandFlag + 1]!, depth + 1);
  });
}

function hasUnsafeGitAlias(command: string): boolean {
  return splitShellSegments(command).some((segment) => {
    const words = unwrapShellWords(segment);
    const gitIndex = words.findIndex((word, index) => basename(word) === "git" && words.slice(0, index).every((prefix) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix)));
    if (gitIndex < 0) return false;
    const args = words.slice(gitIndex + 1);
    return args.some((arg, index) => /^-calias\./i.test(arg) || /^--config-env=alias\./i.test(arg) || ((arg === "-c" || arg === "--config-env") && /^alias\./i.test(args[index + 1] ?? "")));
  });
}

function pushedProtectedBranchIn(command: string, protectedBranches: Set<string>): string | undefined {
  for (const segment of splitShellSegments(command)) {
    const normalized = normalizedGitSegments(segment)[0];
    if (!normalized) continue;
    const words = normalized.split(" ");
    if (words[1] !== "push") continue;
    for (const branch of protectedBranches) {
      for (const refspec of words.slice(2).filter((word) => !word.startsWith("-"))) {
        const destination = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec;
        const normalizedDestination = destination.replace(/^refs\/heads\//, "");
        if (normalizedDestination === branch) return branch;
      }
    }
  }
  return undefined;
}

export function checkGitPolicy(command: string, context: GitPolicyContext): { policy: string; decision: "deny"; reason: string } | undefined {
  if (hasUnsafeGitAlias(command)) return { decision: "deny", policy: "unsafe-git-alias", reason: "Inline Git aliases can hide policy-relevant operations." };
  const protectedBranches = protectedBranchesIn(context);
  const pushed = pushedProtectedBranchIn(command, protectedBranches);
  if (pushed) return { decision: "deny", policy: "protected-branch-push", reason: `Direct pushes to protected branch '${pushed}' are not allowed.` };
  const normalized = normalizedGitSegments(command).join(" ; ");
  if (protectedBranchWriteReason(context) && gitWriteRe.test(normalized)) {
    return { decision: "deny", policy: "protected-branch-write", reason: `Git mutations on protected branch '${context.currentBranch}' are not allowed.` };
  }
  return undefined;
}
