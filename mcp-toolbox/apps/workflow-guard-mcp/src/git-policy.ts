import { basename } from "node:path";
import { splitShellSegments, unwrapShellWords } from "./shell.js";

// Ported from upstream opencode-workflow-guard (#134/#135, W084): `git tag`
// publish flows are release operations, not branch mutations — only tag
// DELETION (-d/--delete) stays flagged as a git write.
//
// W101 (docs/BRANCH_EXIT_POLICY_2026-09-23.md §4): the checkout clause
// exempts -B in addition to -b — the force-create/reset form is TARGET-gated
// (below), not spelling-gated, unifying it with `switch -C` (the position's
// one deliberate with-facts loosening, recorded in the parity log). The
// switch clause joins for the fact-gated detach/discard classes only
// (mirroring rows 5 and 7's checkout treatments): switch -C/-c stay OUT of
// the spelling lane so the target gate decides and the sanctioned
// feature-target force-create keeps its W099-pinned allow.
const gitWriteRe = /\bgit\s+(?:add|rm|mv|commit|merge|rebase|cherry-pick|revert|stash\s+pop|apply|am|restore|reset|update-ref|filter-branch)\b|\bgit\s+tag\s+(?!--?list\b|-l\b)(?:[^|;&]*\s)?(?:-d\b|--delete\b)|\bgit\s+checkout\s+(?!-b\b|-B\b)|\bgit\s+switch\s+(?:-d\b|--detach\b|-f\b|--force(?!-create)\b|--discard-changes\b)|\bgit\s+branch\s+(?:[^|;&]*\s)?-[dDM]\b/;
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
  // W101 (W100 §2.3 twin-matcher discipline): the branch class widens for the
  // pointer family (-f/-m/-M/-C/-c and their long forms) and fetch gains a
  // colon-refspec clause, in the SAME change as the target gate below.
  const extras = /\bgit\s+branch\s+(?:[^|;&]*\s)?-(?:[dDfMCcm]|--force\b|--move\b|--copy\b|--delete\b)|\bgit\s+fetch\s+[^|;&]*:\S/;
  if (gitWriteRe.test(normalized) || extras.test(normalized) || /\bgit\s+(?:switch|checkout)\b/.test(normalized)) return true;
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

// Ported from upstream opencode-workflow-guard (#134, W084): publishing a tag
// is a release operation, not a branch mutation, so explicit tag refspecs are
// exempt from the protected-branch push rules. Upstream's ordering is
// load-bearing: a refspec containing a colon is tag-publish ONLY when its
// DESTINATION is `:refs/tags/...` — checking the tag-shaped source first
// would exempt `refs/tags/v1:main`, whose unqualified destination resolves to
// the protected branch `refs/heads/main` (a real bypass, caught in review).
// Deletion refspecs (`:refs/tags/<name>` — empty source) are never exempt.
// Unlike upstream, the portable core does not execute `git show-ref` to probe
// whether a short name resolves to an existing tag: short names stay under
// the ordinary rule, and they only collide when the name equals a protected
// branch, which is that rule's intended target.
function tagPublishRefspecIn(refspec: string): boolean {
  const token = refspec.replace(/^\+/, "");
  if (token.length === 0 || token.startsWith(":")) return false;
  if (token.includes(":")) return token.includes(":refs/tags/");
  return token.startsWith("refs/tags/");
}

function pushedProtectedBranchIn(command: string, protectedBranches: Set<string>): string | "wildcard-refspec" | undefined {
  for (const segment of splitShellSegments(command)) {
    const normalized = normalizedGitSegments(segment)[0];
    if (!normalized) continue;
    const words = normalized.split(" ");
    if (words[1] !== "push") continue;
    for (const refspec of words.slice(2).filter((word) => !word.startsWith("-"))) {
      // W084 tag-publish exemption first (tag globs stay release operations),
      // then the W101 review P1 wildcard fail-closed: a branch-glob
      // destination maps ALL heads including the protected ones and cannot
      // be resolved to a concrete branch.
      if (tagPublishRefspecIn(refspec)) continue;
      if (refspec.includes("*")) return "wildcard-refspec";
      const destination = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec;
      const normalizedDestination = destination.replace(/^refs\/heads\//, "");
      if (protectedBranches.has(normalizedDestination)) return normalizedDestination;
    }
  }
  return undefined;
}

// ---- W101: the protected-target gate (docs/BRANCH_EXIT_POLICY_2026-09-23.md §4) ----
// Classification by git SEMANTIC, not spelling. The pointer family —
// force/rename/copy/delete (branch, checkout -B, switch -C), update-ref of a
// refs/heads/ path, and fetch destination refspecs — is denied when the
// PARSED TARGET belongs to the protected set, from ANY current branch,
// against the always-on {main, master} base ∪ the caller's facts. Renames
// check BOTH operands (the protected name may be the source or the
// destination); the one-arg rename form targets the CURRENT branch, so it
// requires the fact and fails closed without one. Any shape the parser cannot
// resolve fails closed. Pure exits, creates, and feature-target flows are not
// this gate's business; the current-branch-gated spelling lanes still apply
// on top of the gate (e.g. the target-blind branch -d/-D/-M conservative deny
// on a protected current branch is untouched).

interface PointerInvocation {
  targets: string[];
  uncertain: boolean;
  // The one-arg rename form's target is the CURRENT branch: the membership
  // check consumes the currentBranch fact, and a factless seat fails closed.
  needsCurrentBranch: boolean;
}

const branchValueOptions = new Set(["--format", "--sort", "--points-at"]);
const switchCheckoutFlags = new Set(["-t", "--track", "--no-track", "-m", "--merge", "-g", "--guess", "--no-guess", "--orphan", "--overwrite-ignore", "--no-overwrite-ignore", "--overlay", "--no-overlay", "--ignore-other-worktrees", "--ignore-skip-worktree-bits", "--pathspec-file-nul", "--recurse-submodules", "--no-recurse-submodules", "-p", "--patch"]);
const updateRefFlags = new Set(["--no-deref", "-z", "--worktree", "--strict"]);
const fetchValueOptions = new Set(["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--negotiation-tip", "-j", "--jobs", "-o", "--server-option", "--upload-pack", "--submodule-prefix"]);
const fetchFlags = new Set(["-p", "--prune", "-n", "--no-tags", "-t", "--tags", "--all", "--multiple", "--dry-run", "--atomic", "--force", "--refetch", "-q", "--quiet", "-v", "--verbose", "--progress", "--ipv4", "--ipv6", "-4", "-6", "--auto-maintenance", "--auto-gc", "--write-fetch-head", "--no-write-fetch-head", "--unshallow", "--update-shallow"]);
// W101 review round 3: --refmap is the one fetch value option whose value is
// itself a refspec (the prune mapping) — `--refmap=refs/heads/gone:refs/
// heads/main` with --prune deletes the mapped local branch — so it is
// deliberately NOT a consumed value: both spellings fall into the uncertain
// bucket and fail closed (deliberately absent from fetchValueOptions).

function normalizeBranchRef(token: string): string {
  return token.replace(/^refs\/heads\//, "");
}

interface WordWalk {
  operands: string[];
  uncertain: boolean;
  endOpts: boolean;
}

// Shared operand walk: words[0]="git", words[1]=subcommand; skip equals-forms
// and known value/flag options, collect operands, and mark unrecognized
// option shapes uncertain (fail closed under parse uncertainty).
function walkWords(
  words: string[],
  onShortChar: (ch: string) => boolean, // true = known flag char
  onLong: (word: string) => "flag" | "value" | "unknown",
  shortValueChars?: Set<string>, // short chars whose NEXT token is their value
): WordWalk {
  const operands: string[] = [];
  let uncertain = false;
  let endOpts = false;
  for (let i = 2; i < words.length; i++) {
    const word = words[i]!;
    if (endOpts) { operands.push(word); continue; }
    if (word === "--") { endOpts = true; continue; }
    if (word.startsWith("--")) {
      if (/^--[\w.-]+=/.test(word)) continue;
      const verdict = onLong(word);
      // W101 review P0: a space-form value option consumes its value token —
      // otherwise the value becomes the first operand and shifts the target
      // selection (e.g. `branch -f --points-at HEAD main <sha>` phantom-
      // allowing a protected pointer move).
      if (verdict === "value") { i += 1; continue; }
      if (verdict === "unknown") uncertain = true;
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      let consumesNext = false;
      for (const ch of word.slice(1)) {
        if (shortValueChars?.has(ch)) { consumesNext = true; continue; }
        if (!onShortChar(ch)) uncertain = true;
      }
      // A bundled short-value form consumes the following word; a value
      // fused into the token (`-j2`) still marks the token unknown (the
      // value chars are not flag chars) and fails closed.
      if (consumesNext && i + 1 < words.length) i += 1;
      continue;
    }
    operands.push(word);
  }
  return { operands, uncertain, endOpts };
}

function parseBranch(words: string[]): PointerInvocation | undefined {
  let renameish = false, copyish = false, targetish = false, known = false;
  const walk = walkWords(
    words,
    (ch) => {
      if (ch === "d" || ch === "D" || ch === "f") { targetish = true; known = true; return true; }
      if (ch === "m" || ch === "M") { renameish = true; known = true; return true; }
      if (ch === "c" || ch === "C") { copyish = true; known = true; return true; }
      // List/config flags: never pointer forms, always safe to skip.
      if (ch === "u" || ch === "a" || ch === "r" || ch === "l" || ch === "v" || ch === "i" || ch === "q") return true;
      return false;
    },
    (word) => {
      if (branchValueOptions.has(word)) return "value";
      if (word === "--force" || word === "--delete") { targetish = true; known = true; return "flag"; }
      if (word === "--move") { renameish = true; known = true; return "flag"; }
      if (word === "--copy") { copyish = true; known = true; return "flag"; }
      if (word === "--set-upstream-to" || word === "--edit-description" || word === "--show-current" || word === "--list" || word === "--omit-empty" || word === "--ignore-case" || word === "--create-reflog" || word === "--no-abbrev" || word === "--track" || word === "--no-track" || word === "--recurse-submodules" || word === "--color" || word === "--column" || word === "--abbrev" || word === "--quiet" || word === "--verbose" || word === "--all" || word === "--remotes") return "flag";
      return "unknown";
    },
  );
  if (!known) return undefined;
  if (walk.uncertain || walk.operands.length === 0) return { targets: [], uncertain: true, needsCurrentBranch: false };
  if (renameish) {
    // Rows 11-13: the protected name may be the SOURCE or the DESTINATION.
    if (walk.operands.length === 1) return { targets: [], uncertain: false, needsCurrentBranch: true };
    if (walk.operands.length === 2) return { targets: walk.operands, uncertain: false, needsCurrentBranch: false };
    return { targets: [], uncertain: true, needsCurrentBranch: false };
  }
  if (copyish) {
    // Copy writes the DESTINATION (last operand); the source is read.
    return { targets: [walk.operands[walk.operands.length - 1]!], uncertain: false, needsCurrentBranch: false };
  }
  // Force-set and delete: the first operand is the target branch.
  return { targets: [walk.operands[0]!], uncertain: false, needsCurrentBranch: false };
}

// checkout/switch: only the FORCE-CREATE/RESET form is target-gated; their
// detach/discard/create classes stay with the spelling lanes (fact-gated, per
// the position's class split — a detach target is a sha, never a protected
// ref, so the target gate cannot classify it).
function parseForceCreate(words: string[], forceShort: string): PointerInvocation | undefined {
  let force = false, createSeen = false;
  const walk = walkWords(
    words,
    (ch) => {
      if (ch === forceShort) { force = true; return true; }
      if (words[1] === "switch" && ch === "c") { createSeen = true; return true; }
      if (words[1] === "checkout" && ch === "b") { createSeen = true; return true; }
      return "bdfmtpg".includes(ch);
    },
    (word) => {
      if (switchCheckoutFlags.has(word) || word === "--force" || word === "--discard-changes" || word === "--detach") return "flag";
      if (word === "--create") { createSeen = true; return "flag"; }
      if (word === "--force-create") { force = true; return "flag"; }
      if (words[1] === "checkout" && word === "--orphan") return "flag";
      return "unknown";
    },
  );
  // The create and force-create modes are mutually exclusive in real git;
  // a command carrying both cannot be classified (review round 2
  // watch-item: last-wins semantics would let `-c x -C main` slip the
  // target check past the created branch).
  if (force && createSeen) return { targets: [], uncertain: true, needsCurrentBranch: false };
  if (!force) return undefined;
  if (walk.uncertain || walk.endOpts || walk.operands.length === 0) return { targets: [], uncertain: true, needsCurrentBranch: false };
  return { targets: [walk.operands[0]!], uncertain: false, needsCurrentBranch: false };
}

function parseUpdateRef(words: string[]): PointerInvocation | undefined {
  const walk = walkWords(
    words,
    (ch) => ch === "d" || ch === "z",
    (word) => (updateRefFlags.has(word) ? "flag" : "unknown"),
  );
  // --stdin is deliberately NOT a known flag: refspecs read from stdin cannot
  // be classified, so it falls into the uncertain bucket and fails closed.
  if (walk.uncertain) return { targets: [], uncertain: true, needsCurrentBranch: false };
  if (walk.operands.length === 0) return undefined;
  const branchRef = /^refs\/heads\/(.+)$/.exec(walk.operands[0]!);
  // HEAD and refs/heads-sibling forms keep their existing-lane semantics:
  // on the protected branch the spelling lane denies every update-ref;
  // elsewhere HEAD updates the CURRENT branch (own-branch, allow) — the
  // exotic symbolic-ref forms are the recorded row-25 residual.
  if (!branchRef) return undefined;
  return { targets: [branchRef[1]!], uncertain: false, needsCurrentBranch: false };
}

function parseFetch(words: string[]): PointerInvocation | undefined {
  // W101 review round 3: --refmap (either spelling) is a hidden refspec —
  // its value is the prune mapping, and with --prune a mapped absent source
  // DELETES the mapped local destination. Fail closed before any parsing
  // (the equals-form skip in the shared walk would otherwise never surface
  // it).
  if (words.some((word) => word.startsWith("--refmap"))) return { targets: [], uncertain: true, needsCurrentBranch: false };
  const walk = walkWords(
    words,
    (ch) => "vqtnp46".includes(ch),
    (word) => {
      if (fetchFlags.has(word)) return "flag";
      if (fetchValueOptions.has(word)) return "value";
      return "unknown";
    },
    new Set(["j", "o"]), // -j/--jobs and -o/--server-option consume a value
  );
  if (walk.uncertain) return { targets: [], uncertain: true, needsCurrentBranch: false };
  // Fail-closed across EVERY colon-bearing operand (review round 2): a
  // benign first refspec, a URL remote, or an option value must not shield
  // a later `main:refs/heads/<protected>` refspec — git processes multiple
  // refspecs in one fetch, so every destination is checked and the caller
  // denies if ANY belongs to the protected set.
  const destinations: string[] = [];
  for (const refspec of walk.operands) {
    const colon = refspec.lastIndexOf(":");
    if (colon < 0) continue;
    const destination = refspec.slice(colon + 1);
    if (destination.length === 0) continue;
    // Tag destinations are release operations, not branch pointer moves
    // (the W084 shape); a wildcard BRANCH destination maps all heads
    // including the protected ones and fails closed (review P1).
    if (destination.startsWith("refs/tags/")) continue;
    if (destination.includes("*")) return { targets: [], uncertain: true, needsCurrentBranch: false };
    destinations.push(destination);
  }
  if (destinations.length === 0) return undefined;
  return { targets: destinations, uncertain: false, needsCurrentBranch: false };
}

function checkPointerTarget(words: string[], protectedBranches: Set<string>, context: GitPolicyContext): { decision: "deny"; policy: string; reason: string } | undefined {
  const sub = words[1];
  let invocation: PointerInvocation | undefined;
  if (sub === "branch") invocation = parseBranch(words);
  else if (sub === "checkout" || sub === "switch") invocation = parseForceCreate(words, sub === "checkout" ? "B" : "C");
  else if (sub === "update-ref") invocation = parseUpdateRef(words);
  else if (sub === "fetch") invocation = parseFetch(words);
  if (!invocation) return undefined;
  if (invocation.uncertain) {
    return { decision: "deny", policy: "protected-branch-write", reason: "Git pointer command could not be safely parsed; failing closed." };
  }
  if (invocation.needsCurrentBranch) {
    // The one-arg rename's target IS the current branch: a factless seat
    // cannot classify it and fails closed (§4.3 bullet 2, row 12); with the
    // fact the membership check runs against it.
    if (!context.currentBranch) {
      return { decision: "deny", policy: "protected-branch-write", reason: "Branch rename targets the current branch, which was not supplied; failing closed." };
    }
    if (protectedBranches.has(normalizeBranchRef(context.currentBranch))) {
      return { decision: "deny", policy: "protected-branch-write", reason: `Branch pointer writes on protected branch '${normalizeBranchRef(context.currentBranch)}' are not allowed.` };
    }
    return undefined;
  }
  for (const target of invocation.targets) {
    if (protectedBranches.has(normalizeBranchRef(target))) {
      return { decision: "deny", policy: "protected-branch-write", reason: `Branch pointer writes on protected branch '${normalizeBranchRef(target)}' are not allowed.` };
    }
  }
  return undefined;
}

export function checkGitPolicy(command: string, context: GitPolicyContext): { policy: string; decision: "deny"; reason: string } | undefined {
  if (hasUnsafeGitAlias(command)) return { decision: "deny", policy: "unsafe-git-alias", reason: "Inline Git aliases can hide policy-relevant operations." };
  const protectedBranches = protectedBranchesIn(context);
  const pushed = pushedProtectedBranchIn(command, protectedBranches);
  if (pushed === "wildcard-refspec") {
    return { decision: "deny", policy: "protected-branch-push", reason: "Wildcard push refspec destinations cannot be resolved to concrete branches; failing closed." };
  }
  if (pushed) return { decision: "deny", policy: "protected-branch-push", reason: `Direct pushes to protected branch '${pushed}' are not allowed.` };
  // W101: the semantic target gate runs per segment BEFORE the
  // current-branch-gated spelling lanes; deny-class ordering is preserved
  // (alias and push keep their primacy), the gate's deny names the protected
  // target, and the spelling lanes still catch everything the gate allows
  // (e.g. the target-blind branch -d/-D/-M conservative deny on a protected
  // current branch — W100 row 16).
  for (const segment of splitShellSegments(command)) {
    const normalized = normalizedGitSegments(segment)[0];
    if (!normalized) continue;
    const gate = checkPointerTarget(normalized.split(" "), protectedBranches, context);
    if (gate) return gate;
  }
  const normalized = normalizedGitSegments(command).join(" ; ");
  if (protectedBranchWriteReason(context) && gitWriteRe.test(normalized)) {
    return { decision: "deny", policy: "protected-branch-write", reason: `Git mutations on protected branch '${context.currentBranch}' are not allowed.` };
  }
  return undefined;
}