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
const gitWriteRe = /\bgit\s+(?:add|rm|mv|commit|merge|rebase|cherry-pick|revert|stash\s+pop|apply|am|restore|reset|update-ref|filter-branch)\b|\bgit\s+tag\s+(?!--?list\b|-l\b)(?:[^|;&]*\s)?(?:-d\b|--delete\b)|\bgit\s+checkout\s+(?!-b\b|-B\b)|\bgit\s+switch\s+(?:-d\b|--detach\b|-f\b|--force(?!-create)\b|--discard-changes\b)|\bgit\s+branch\s+(?:[^|;&]*\s)?-[dDM]\b|\bgit\s+pull\b/;
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
  // W103: symbolic-ref's >=2-token forms (write: <name> <ref>; delete:
  // --delete <name>) are mutations — the gate and the twin widen together
  // (§2.3); the one-operand read stays a non-mutation. The coarse token
  // match is deliberate: the precise classification is the target gate's
  // job; the twin only carries the mutation signal for the read-only-role
  // lane.
  const extras = /\bgit\s+branch\s+(?:[^|;&]*\s)?-(?:[dDfMCcm]|--force\b|--move\b|--copy\b|--delete\b)|\bgit\s+fetch\s+[^|;&]*:\S|\bgit\s+pull\b|\bgit\s+symbolic-ref\s+\S+\s+\S/;
  if (gitWriteRe.test(normalized) || extras.test(normalized) || /\bgit\s+(?:switch|checkout)\b/.test(normalized)) return true;
  // W102 review round 1 P3: the wrapper walk is SHARED (one detection
  // implementation, not a verbatim copy) so the mutation matcher and the
  // deny path cannot drift.
  return wrapperCommands(command).some((inner) => hasGitMutation(inner, depth + 1));
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

function pushedProtectedBranchIn(command: string, protectedBranches: Set<string>, currentBranch?: string): string | "wildcard-refspec" | undefined {
  for (const segment of splitShellSegments(command)) {
    const normalized = normalizedGitSegments(segment)[0];
    if (!normalized) continue;
    const words = normalized.split(" ");
    if (words[1] !== "push") continue;
    // W101 review round 8 + W103: --mirror/--all pushes update and delete
    // ALL remote refs including the protected ones — no refspec names
    // them, so the per-refspec destination match cannot see them. The
    // check is per SEGMENT, not per refspec: the pre-W103 placement
    // inside the refspec loop never ran for a flag-driven push with no
    // remote/refspec arguments (`git push --mirror`). Fail closed
    // (recorded as SECURITY_ASSURANCE #24).
    if (words.slice(2).some((word) => word === "--mirror" || word === "--all")) return "wildcard-refspec";
    const args = words.slice(2).filter((word) => !word.startsWith("-"));
    for (const refspec of args) {
      // W084 tag-publish exemption first (tag globs stay release operations),
      // then the W101 review P1 wildcard fail-closed: a branch-glob
      // destination maps ALL heads including the protected ones and cannot
      // be resolved to a concrete branch.
      if (tagPublishRefspecIn(refspec)) continue;
      if (refspec.includes("*")) return "wildcard-refspec";
      // W101 review round 7: strip a leading + from a colon-less refspec —
      // `git push origin +main` force-updates the protected remote branch
      // exactly like its colon twin `+main:main` (pinned deny), and the
      // un-stripped token defeated both the refs/heads/ strip and the
      // protected-set lookup.
      const destination = (refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec).replace(/^\+/, "");
      const normalizedDestination = destination.replace(/^refs\/heads\//, "");
      if (protectedBranches.has(normalizedDestination)) return normalizedDestination;
    }
    // W103 (SECURITY_ASSURANCE #22's queued resolution): HEAD/@ refspecs
    // and the default push (no refspec beyond the remote slot — git's
    // grammar makes the first non-option argument the repository) resolve
    // to the CURRENT branch; from a protected seat that is the protected
    // remote branch. Resolve against the currentBranch fact (the same
    // mechanism round 4 built for the one-arg rename source). A FACTLESS
    // seat keeps the as-found allow: the destination is only knowable from
    // the fact, so this is the documented W090 fail-open class (the
    // round-8 bare-pull symmetry), not a fail-closed target — the gate
    // adds denies, never loosens.
    const refspecs = args.length >= 2 ? args.slice(1) : [];
    const aliasPush = args.length <= 1 || refspecs.some((refspec) => {
      const token = refspec.replace(/^\+/, "");
      return token === "HEAD" || token === "@";
    });
    if (aliasPush && currentBranch) {
      const normalizedCurrent = normalizeBranchRef(currentBranch);
      if (protectedBranches.has(normalizedCurrent)) return normalizedCurrent;
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
  // The one-arg rename form writes BOTH names: its targets carry the
  // DESTINATION operand and `needsCurrentBranch` marks the SOURCE (the
  // current branch, renamed away) — the source requires the fact, and a
  // factless seat fails closed.
  needsCurrentBranch: boolean;
}

const branchValueOptions = new Set(["--format", "--sort", "--points-at"]);
const switchCheckoutFlags = new Set(["-t", "--track", "--no-track", "-m", "--merge", "-g", "--guess", "--no-guess", "--orphan", "--overwrite-ignore", "--no-overwrite-ignore", "--overlay", "--no-overlay", "--ignore-other-worktrees", "--ignore-skip-worktree-bits", "--pathspec-file-nul", "--recurse-submodules", "--no-recurse-submodules", "-p", "--patch"]);
const updateRefFlags = new Set(["--no-deref", "-z", "--worktree", "--strict"]);
const fetchValueOptions = new Set(["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--negotiation-tip", "-j", "--jobs", "-o", "--server-option", "--upload-pack", "--submodule-prefix", "-s", "--strategy", "-X", "--strategy-option", "-S", "--gpg-sign"]);
const fetchFlags = new Set(["-p", "--prune", "-n", "--no-tags", "-t", "--tags", "--all", "--multiple", "--dry-run", "--atomic", "--force", "--refetch", "-q", "--quiet", "-v", "--verbose", "--progress", "--ipv4", "--ipv6", "-4", "-6", "--auto-maintenance", "--auto-gc", "--write-fetch-head", "--no-write-fetch-head", "--unshallow", "--update-shallow", "--no-tags", "--rebase", "-r", "--autostash", "--ff", "--no-ff", "--ff-only", "--commit", "--no-commit", "--verify-signatures", "--no-verify", "--stat", "--no-stat", "--log", "--no-edit", "--edit", "--allow-unrelated-histories", "--squash", "--no-squash"]);
// Pull shares the fetch walker (round 8): its integration-side options are
// known flags or consumed values; --refmap stays vetoed (shared walk).
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
  let renameish = false, copyish = false, targetish = false, deleteish = false, known = false;
  const walk = walkWords(
    words,
    (ch) => {
      if (ch === "d" || ch === "D" || ch === "f") { targetish = true; known = true; if (ch !== "f") deleteish = true; return true; }
      if (ch === "m" || ch === "M") { renameish = true; known = true; return true; }
      if (ch === "c" || ch === "C") { copyish = true; known = true; return true; }
      // List/config flags: never pointer forms, always safe to skip.
      if (ch === "u" || ch === "a" || ch === "r" || ch === "l" || ch === "v" || ch === "i" || ch === "q") return true;
      return false;
    },
    (word) => {
      if (branchValueOptions.has(word)) return "value";
      if (word === "--force" || word === "--delete") { targetish = true; known = true; if (word === "--delete") deleteish = true; return "flag"; }
      if (word === "--move") { renameish = true; known = true; return "flag"; }
      if (word === "--copy") { copyish = true; known = true; return "flag"; }
      if (word === "--set-upstream-to" || word === "--edit-description" || word === "--show-current" || word === "--list" || word === "--omit-empty" || word === "--ignore-case" || word === "--create-reflog" || word === "--no-abbrev" || word === "--track" || word === "--no-track" || word === "--recurse-submodules" || word === "--color" || word === "--column" || word === "--abbrev" || word === "--quiet" || word === "--verbose" || word === "--all" || word === "--remotes") return "flag";
      return "unknown";
    },
  );
  if (!known) return undefined;
  // W101 review round 6 watch-item: conflicting branch modes (a bundled
  // -dc or -md) cannot be classified — delete is variadic while copy/
  // rename shape their targets differently — so a bundle carrying modes
  // from different families fails closed (real git rejects the
  // combination; the conservative direction costs nothing valid).
  if (deleteish && (renameish || copyish)) return { targets: [], uncertain: true, needsCurrentBranch: false };
  if (renameish && copyish) return { targets: [], uncertain: true, needsCurrentBranch: false };
  if (walk.uncertain || walk.operands.length === 0) return { targets: [], uncertain: true, needsCurrentBranch: false };
  if (renameish) {
    // Rows 11-13: the protected name may be the SOURCE or the DESTINATION.
    // The two-arg form checks both operands; the ONE-ARG form renames the
    // current branch to the operand, so BOTH names are written — the
    // destination operand force-overwrites a protected branch when it names
    // one (review round 4: `git branch -M main` from a feature branch
    // destroys refs/heads/main), and the source needs the currentBranch
    // fact (factless fails closed, row 12).
    if (walk.operands.length === 1) return { targets: walk.operands, uncertain: false, needsCurrentBranch: true };
    if (walk.operands.length === 2) return { targets: walk.operands, uncertain: false, needsCurrentBranch: false };
    return { targets: [], uncertain: true, needsCurrentBranch: false };
  }
  if (copyish) {
    // Copy writes the DESTINATION (last operand); the source is read.
    return { targets: [walk.operands[walk.operands.length - 1]!], uncertain: false, needsCurrentBranch: false };
  }
  if (deleteish) {
    // Review round 5: delete is VARIADIC in git (`git branch -D <name>…`
    // deletes every named branch), so every operand is a written target —
    // the first-operand-only rule would let `git branch -D feat2 main`
    // destroy the protected branch that is named second.
    return { targets: walk.operands, uncertain: false, needsCurrentBranch: false };
  }
  // Force-set: the first operand is the target branch; the second, when
  // present, is a start-point (read-only).
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

function parseUpdateRef(words: string[], symbolicRef = false): PointerInvocation | undefined {
  const walk = walkWords(
    words,
    (ch) => ch === "d" || ch === "z" || (symbolicRef && ch === "q"),
    (word) => (updateRefFlags.has(word) || (symbolicRef && (word === "--short" || word === "--quiet")) ? "flag" : "unknown"),
  );
  // --stdin is deliberately NOT a known flag: refspecs read from stdin cannot
  // be classified, so it falls into the uncertain bucket and fails closed.
  if (walk.uncertain) return { targets: [], uncertain: true, needsCurrentBranch: false };
  if (walk.operands.length === 0) return undefined;
  const branchRef = /^refs\/heads\/(.+)$/.exec(walk.operands[0]!);
  // HEAD and refs/heads-sibling forms keep their existing-lane semantics:
  // on the protected branch the spelling lane denies every update-ref;
  // elsewhere HEAD updates the CURRENT branch (own-branch, allow). For
  // symbolic-ref the HEAD-form repoint stays the deliberate row-25
  // exit-class allow (this first-operand check is what preserves it).
  if (!branchRef) return undefined;
  // W103 residual #21: symbolic-ref's ONE-operand form is a READ (it
  // prints the referent) — only the two-operand form repoints the name.
  // update-ref keeps its existing shape: a bare refs/heads/ operand there
  // is always a write target (real git requires -d or a new value).
  if (symbolicRef && walk.operands.length < 2) return undefined;
  // W103: the symbolic-ref write form writes BOTH names — the repointed
  // name (operand 0) and the referent it is aimed at (operand 1): a
  // symref aimed AT a protected branch routes later commits through the
  // protected ref (the rename lane's both-operands principle, rows 11-13).
  // update-ref's second operand is a VALUE (a sha snapshot), not a live
  // pointer, so it stays unchecked.
  const targets = symbolicRef ? [branchRef[1]!, walk.operands[1]!] : [branchRef[1]!];
  return { targets, uncertain: false, needsCurrentBranch: false };
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
    (ch) => "vqtnp46r".includes(ch),
    (word) => {
      if (fetchFlags.has(word)) return "flag";
      if (fetchValueOptions.has(word)) return "value";
      return "unknown";
    },
    new Set(["j", "o", "s", "S", "X"]), // -j/-o/-s/-S/-X consume a value
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
  else if (sub === "update-ref" || sub === "symbolic-ref") invocation = parseUpdateRef(words, sub === "symbolic-ref");
  else if (sub === "fetch" || sub === "pull") {
    // W101 review round 8: pull runs git fetch with the same arguments —
    // its colon refspecs are fetch refspecs writing local branches, so the
    // pull spelling shares the fetch lane's destination sweep (and the
    // --refmap veto). The merge half (into the current branch) is the
    // gitWriteRe pull clause's current-branch-gated job.
    invocation = parseFetch(words);
  }
  if (!invocation) return undefined;
  if (invocation.uncertain) {
    return { decision: "deny", policy: "protected-branch-write", reason: "Git pointer command could not be safely parsed; failing closed." };
  }
  if (invocation.needsCurrentBranch) {
    // The one-arg rename writes BOTH names: the current branch (renamed
    // away — the source needs the fact, row 12) and the destination operand
    // (force-overwrites a protected branch when it names one — review
    // round 4). A factless seat cannot classify the source and fails
    // closed.
    if (!context.currentBranch) {
      return { decision: "deny", policy: "protected-branch-write", reason: "Branch rename targets the current branch, which was not supplied; failing closed." };
    }
    if (protectedBranches.has(normalizeBranchRef(context.currentBranch))) {
      return { decision: "deny", policy: "protected-branch-write", reason: `Branch pointer writes on protected branch '${normalizeBranchRef(context.currentBranch)}' are not allowed.` };
    }
  }
  for (const target of invocation.targets) {
    if (protectedBranches.has(normalizeBranchRef(target))) {
      return { decision: "deny", policy: "protected-branch-write", reason: `Branch pointer writes on protected branch '${normalizeBranchRef(target)}' are not allowed.` };
    }
  }
  return undefined;
}

export function wrapperCommands(command: string): string[] {
  // The wrapper detection shared by BOTH matchers (hasGitMutation and the
  // deny path — W102 review round 1 P3: one implementation, not a verbatim
  // copy): sh-family interpreters exposing their command string via -c.
  // `sh script.sh` is NOT a wrapper (script contents are unknowable — the
  // file-scanner's territory). The fused -c form (`sh -c'git commit'` — no
  // space between -c and the quote) is real shell getopt semantics: the
  // remainder of the word IS the option-argument, and the tokenizer glues
  // the quoted text into the word — the fused spelling is detected, not a
  // bypass (W102 review round 1 P1). env/timeout/VAR= prefixes are consumed
  // by unwrapShellWords, so prefixed wrappers ARE detected (the W101-era
  // "env limitation" note was factually wrong — corrected by review round 1
  // P2). busybox sh / exotic interpreter names remain the honest edge.
  return splitShellSegments(command).flatMap((segment) => {
    const words = unwrapShellWords(segment);
    if (!/^(?:ba|z|da|k)?sh$/i.test(basename(words[0] ?? ""))) return [];
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!;
      if (word === "--") return [];
      if (!/^[+-]/.test(word)) return [];
      // W102 review round 2: getopt does not stop at the word head — a
      // bundle containing a `c` option consumes the REST of the word as
      // -c's option-argument (`-ec'cmd'`, `-xc`…), and the spaced `-ec
      // 'cmd'` and `-o <value> -c` forms were the same bypass. The
      // generalized -Xc matcher is the same shape the boundary and shell
      // lanes' findIndex flag-finders implement for the NEXT-word form
      // (round 3 note: those precedents are non-capturing next-word
      // finders — this walker additionally handles the fused form, which
      // is why the sequential walk exists); after the c option, a
      // non-empty remainder is the fused command and an empty remainder
      // means the command is the next word.
      const cMatch = /^-[a-zA-Z]*c(.*)$/s.exec(word);
      if (cMatch) {
        const fused = cMatch[1]!.replace(/^['"]|['"]$/g, "");
        return fused.length > 0 ? [fused] : (words[i + 1] ? [words[i + 1]!] : []);
      }
      // -o consumes its value — bundle-aware (W102 review round 3 B1): a
      // bundle ENDING in o consumes the next word (`bash -euo pipefail -c
      // '...'` — the walk died at the non-dash value word before reaching
      // -c); a fused `-opipefail` is correctly NOT a value-consumer since o
      // is not the last option char. For the sh-family, `-o <name>` is the
      // value option in common use. W102 review round 4 (B2): -O is also a
      // value option (bash shopt: `-O <shopt>` sets, `+O`/`+o` unset —
      // captured red live: allow on main pre-fix), and the plus-family
      // (`+O`, `+o`) is option-shaped too — bash's plus-options are the
      // opposite-sense shopt set, so the walk must treat them as options,
      // not positionals.
      if (/^-[a-zA-Z]*[oO]$/.test(word) && words[i + 1]) i += 1;
      if (/^\+[a-zA-Z]*[oO]$/.test(word) && words[i + 1]) i += 1;
    }
    return [];
  });
}

export function checkGitPolicy(command: string, context: GitPolicyContext, depth = 0): { policy: string; decision: "deny"; reason: string } | undefined {
  // W102 (residual #20's closure): depth-capped like hasGitMutation — at the
  // cap the classification is unresolvable and fails closed.
  if (depth >= 16) return { decision: "deny", policy: "protected-branch-write", reason: "Git command nesting depth exceeded; failing closed." };
  if (hasUnsafeGitAlias(command)) return { decision: "deny", policy: "unsafe-git-alias", reason: "Inline Git aliases can hide policy-relevant operations." };
  const protectedBranches = protectedBranchesIn(context);
  const pushed = pushedProtectedBranchIn(command, protectedBranches, context.currentBranch);
  if (pushed === "wildcard-refspec") {
    return { decision: "deny", policy: "protected-branch-push", reason: "Push could not be resolved to concrete branch destinations (wildcard refspec, --mirror, or --all); failing closed." };
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
  // W102: the wrapper recursion — the deny class must not be bypassable by
  // wrapping. sh-family -c wrappers are transparent to the FULL git
  // classification with the same seat facts (a wrapper executes in the same
  // repository, so the currentBranch fact applies to the inner command).
  // Direct-segment evidence keeps reason-attribution primacy; the recursion
  // runs last.
  for (const inner of wrapperCommands(command)) {
    const verdict = checkGitPolicy(inner, context, depth + 1);
    if (verdict) return verdict;
  }
  return undefined;
}