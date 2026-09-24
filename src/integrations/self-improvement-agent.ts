import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createGitCandidateWorkspace,
  createSelfImprovementLoop,
  type CommandRunner,
  type ImprovementProposal,
  type LoopAuthority,
  type LoopIterationRecord,
  type LoopObjective,
  type LoopOutcome,
  type ProposalContext,
  type ProposalSource,
} from "./self-improvement-loop.js";
import type { SelfImprovementSpec } from "./self-improvement-registry.js";

/**
 * Checkpoint F — the production self-improvement loop wiring: an agent-driven
 * `ProposalSource`, an agent applier for the git candidate workspace, a
 * measure over a hub-executed command, and a containment-routed git runner,
 * assembled into the W073 loop by `createAgentDrivenRunLoop`.
 *
 * Trust boundary (stated precisely): this module is prompt-side composition
 * over the W073 seams and grants no authority. Every candidate still routes
 * through the canonical run lifecycle (`begin` → `finish`), so a candidate is
 * committed only after the kernel reached `VERIFIED` on fresh evidence (hub
 * reviewer + test runner when the run is review-gated). The agent sees the
 * operator's objective as advisory text — the reviewer's run ask is bound by
 * the loop (P1-2), not by anything here.
 *
 * Ruler integrity (anti-reward-hacking; guard-policy tier model, 2026-09-21):
 * the loop must never be pointed at a surface the operator classifies as its
 * own ruler — live runtime config, credentials, or the guard/policy source
 * itself (tier T0). The enforcement for that is the guard's non-overridable
 * deny, not this module; this wiring adds no bypass and records the
 * expectation here so a workspace misconfiguration is at least describable.
 * Prompt templates and the measure command are operator/host-config seams
 * (tier T1 promotion into the runtime); their defaults live in versioned
 * source where PR review (tier T2) carries the audit.
 *
 * Prompt templates are the seam an operator (or a host agent-config surface)
 * customizes: `{{placeholder}}` substitution fails closed on unknown
 * placeholders — naming the known set in the error, so the sanctioned way
 * forward is always stated — and a typo can never silently ship a broken
 * prompt. The defaults below are honestly advisory text; the kernel gates
 * decide nothing they say.
 */

/** One agent turn the loop wiring needs. `runId` binds an apply turn to its canonical run's application. */
export interface AgentTurnInput {
  readonly kind: "proposal" | "apply";
  readonly prompt: string;
  readonly workspace: string;
  /** Set for apply turns: the canonical run whose application hosts the turn. */
  readonly runId?: string;
}

export interface AgentTurnResult {
  /** The agent's final reply text (the proposal source parses it; the applier ignores it). */
  readonly result: string;
  /** Metered cost of the turn; accumulates into the loop's `usageUsd` supplier. */
  readonly costUsd: number;
}

export type AgentTurnRunner = (input: AgentTurnInput) => Promise<AgentTurnResult>;

/**
 * Render a `{{placeholder}}` template. Unknown or unterminated placeholders
 * fail closed. The check runs on the TEMPLATE, never on the rendered text:
 * substituted values are data, so agent- or objective-authored content
 * containing `{{...}}` passes through untouched.
 */
export function renderPromptTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const known = Object.keys(values).join(", ");
  for (const match of template.matchAll(/\{\{(\w*)\}\}/g)) {
    const name = match[1] ?? "";
    if (name.length === 0 || values[name] === undefined) {
      throw new TypeError(
        `prompt template references an unknown placeholder {{${name}}} (known placeholders: ${known})`,
      );
    }
  }
  const withoutValidPlaceholders = template.replace(/\{\{\w+\}\}/g, "");
  if (withoutValidPlaceholders.includes("{{")) {
    throw new TypeError("prompt template contains an unterminated or malformed placeholder");
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? "");
}

function formatHistory(history: readonly LoopIterationRecord[]): string {
  if (history.length === 0) return "(no iterations yet)";
  return history
    .map((entry) => `  #${entry.iteration} ${entry.verdict} ${entry.proposalId} — ${entry.reason}`)
    .join("\n");
}

function formatBest(best: ProposalContext["best"]): string {
  if (best === undefined) return "none yet";
  return best.score === undefined ? best.proposalId : `${best.proposalId} (score ${best.score})`;
}

/**
 * Checkpoint F default proposal prompt. Placeholders: `{{objective}}`,
 * `{{iteration}}`, `{{accepted}}`, `{{rejected}}`, `{{best}}`, `{{history}}`.
 * W098: the section ORDER is the invariant — stable preamble first, the
 * append-only history second, the per-iteration counters last — so provider
 * prefix caches grow with the history. The W098 ordering pin enforces it.
 * The JSON reply contract matches `parseProposalReply`.
 */
export const DEFAULT_PROPOSAL_PROMPT_TEMPLATE = `You are the proposal source for a bounded self-improvement loop.

Objective (operator-authored, authoritative): {{objective}}

Task: propose exactly ONE next improvement candidate for the repository working toward the objective.
Reply with ONLY a JSON object (optionally in a \`\`\`json fenced block) shaped as:
{"id": "<short-kebab-id>", "hypothesis": "<one-sentence change hypothesis>", "target": "<optional path or area>"}

Rules:
- The hypothesis must describe one concrete, small, testable change.
- Propose the NEXT change; never restate work the history shows as accepted.
- Rejected candidates were discarded; their reasons are in the history.

Loop state:
- iteration history:
{{history}}
- iteration: {{iteration}}
- accepted candidates: {{accepted}}
- rejected candidates: {{rejected}}
- incumbent best: {{best}}
`;

/**
 * Checkpoint F default apply prompt. Placeholders: `{{objective}}`,
 * `{{hypothesis}}`, `{{target}}`, `{{workspace}}`. The applier never commits:
 * the loop's gate verifies and commits.
 */
export const DEFAULT_APPLY_PROMPT_TEMPLATE = `You are the applier for one candidate of a bounded self-improvement loop.

Objective (operator-authored, authoritative): {{objective}}
Candidate hypothesis: {{hypothesis}}
Candidate target: {{target}}

Task: implement exactly this change in the workspace at {{workspace}}. Keep the change minimal and
consistent with the objective. Do not commit anything; the loop's verification gate commits accepted
candidates. When finished, reply with a one-sentence summary of what changed.
`;

/**
 * Parses an agent reply into an `ImprovementProposal`. Precedence: the whole
 * reply parses first (a bare JSON reply wins); otherwise the LAST ```json
 * fenced block wins. Anything else fails closed — the loop treats a
 * proposal-source failure as a stop, never as a mutation.
 */
export function parseProposalReply(input: { readonly reply: string; readonly fallbackId: string }): ImprovementProposal {
  const fenced = [...input.reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const candidates = [...fenced.map((match) => match[1]), input.reply];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined || candidate.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const hypothesis = record.hypothesis;
    if (typeof hypothesis !== "string" || hypothesis.trim().length === 0) continue;
    const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : input.fallbackId;
    const target = typeof record.target === "string" && record.target.trim().length > 0 ? record.target.trim() : undefined;
    return { id, hypothesis, ...(target === undefined ? {} : { target }) };
  }
  throw new TypeError("proposal reply contained no parseable JSON proposal with a non-empty hypothesis");
}

export function createAgentProposalSource(options: {
  readonly turn: AgentTurnRunner;
  readonly workspace: string;
  readonly promptTemplate?: string;
  readonly parse?: typeof parseProposalReply;
}): ProposalSource {
  const parse = options.parse ?? parseProposalReply;
  return {
    async next(context: ProposalContext): Promise<ImprovementProposal | undefined> {
      const prompt = renderPromptTemplate(options.promptTemplate ?? DEFAULT_PROPOSAL_PROMPT_TEMPLATE, {
        objective: context.objective,
        iteration: String(context.iteration),
        accepted: String(context.accepted),
        rejected: String(context.rejected),
        best: formatBest(context.best),
        history: formatHistory(context.history),
      });
      const reply = await options.turn({ kind: "proposal", prompt, workspace: options.workspace });
      return parse({ reply: reply.result, fallbackId: `proposal-${context.iteration}` });
    },
  };
}

/**
 * The agent applier seam for `createGitCandidateWorkspace`. It performs the
 * apply turn and deliberately returns `undefined`: whether the tree changed
 * is decided by `git status --porcelain` (the workspace's own detection), so
 * an agent's claim can never fabricate — or suppress — a change.
 */
export function createAgentMutator(options: {
  readonly turn: AgentTurnRunner;
  readonly objective: string;
  readonly promptTemplate?: string;
}): NonNullable<Parameters<typeof createGitCandidateWorkspace>[0]["mutate"]> {
  return async (input) => {
    const prompt = renderPromptTemplate(options.promptTemplate ?? DEFAULT_APPLY_PROMPT_TEMPLATE, {
      objective: options.objective,
      hypothesis: input.proposal.hypothesis,
      target: input.proposal.target ?? "(unspecified)",
      workspace: input.workspace,
    });
    await options.turn({ kind: "apply", prompt, workspace: input.workspace, runId: input.runId });
    return undefined;
  };
}

/**
 * Parses a measure command's stdout as a single finite number. Anything else
 * fails closed (the candidate is rejected, never scored).
 */
export function parseScalarScore(output: string): number {
  const trimmed = output.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    throw new TypeError(`measure command output is not a single finite number: ${JSON.stringify(trimmed.slice(0, 80))}`);
  }
  const score = Number(trimmed);
  if (!Number.isFinite(score)) {
    throw new TypeError(`measure command output is not a finite number: ${JSON.stringify(trimmed.slice(0, 80))}`);
  }
  return score;
}

/** A `LoopObjective.measure` over a hub-executed command that prints its score to stdout. */
export function createShellMeasure(options: {
  readonly shell: (command: string, cwd: string) => Promise<string>;
  readonly command: string;
  readonly workspace: string;
}): NonNullable<LoopObjective["measure"]> {
  return async () => parseScalarScore(await options.shell(options.command, options.workspace));
}

/**
 * Containment-routed git runner (Checkpoint F box 2): every invocation is a
 * constant command string executed through the hub's contained shell executor
 * — application authorization plus the containment backend, exactly like the
 * `/bash` route — instead of raw `execFile` outside containment.
 *
 * Commit messages are staged INSIDE the workspace's `.git/` directory (under a
 * hex-UUID name, 0600, removed after the attempt): `.git` content never shows
 * in `git status`, and the file is inside the only path the containment
 * backend mounts, so `git commit -F` can actually read it in the sandbox. The
 * commit command carries hub-side identity (`-c user.name/email` — the
 * sandbox clears the environment, so global gitconfig is unreachable) and
 * hook hardening (`--no-verify` plus `core.hooksPath=/dev/null`), so an agent
 * cannot smuggle a planted pre-commit hook into the commit path. Residual
 * (recorded, not fixed): a repo-configured clean filter in `.gitattributes` /
 * `.git/config` still runs during `git add -A`, so committed content can
 * differ from the diff the reviewer saw; the enforcement for not pointing the
 * loop at untrusted repositories stays with the operator and the guard.
 * Anything beyond the seven verbs the W073 workspace needs is refused.
 */
export function createContainedGitRunner(options: {
  readonly shell: (command: string, cwd: string) => Promise<string>;
  readonly authorName: string;
  readonly authorEmail: string;
}): CommandRunner {
  const constantCommands = new Set([
    "git status --porcelain",
    "git add -A",
    "git rev-parse HEAD",
    "git rev-parse --is-inside-work-tree",
    "git reset --hard HEAD",
    "git clean -fd",
  ]);
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const identity = `-c user.name=${quote(options.authorName)} -c user.email=${quote(options.authorEmail)}`;
  return async (command, args, runnerOptions) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (constantCommands.has(invocation)) {
      return { stdout: await options.shell(invocation, runnerOptions.cwd), stderr: "" };
    }
    if (invocation.startsWith("git commit -m ")) {
      const message = args[2];
      if (typeof message !== "string") throw new TypeError("git commit requires a message argument");
      // Staged under .git so the containment mount (workspace cwd only) can
      // read it and `git status` never sees it. A `.git` FILE (linked
      // worktree/submodule) fails the write and the candidate is rejected
      // fail-closed.
      const messageFile = join(runnerOptions.cwd, ".git", `rsi-message-${randomUUID()}.msg`);
      writeFileSync(messageFile, message, { encoding: "utf8", mode: 0o600 });
      try {
        const commitCommand = `git ${identity} -c core.hooksPath=/dev/null commit --no-verify -F ${quote(messageFile)}`;
        return { stdout: await options.shell(commitCommand, runnerOptions.cwd), stderr: "" };
      } finally {
        rmSync(messageFile, { force: true });
      }
    }
    throw new TypeError(`contained git runner refuses unexpected git invocation: ${invocation}`);
  };
}

export interface AgentDrivenRunLoopDeps {
  /** The canonical run lifecycle the loop routes every candidate through. */
  readonly authority: LoopAuthority;
  readonly turn: AgentTurnRunner;
  readonly gitRun: CommandRunner;
  /** When set, candidates are scored by this hub-executed measure; without one the first verified candidate ends the loop. */
  readonly measure?: {
    readonly shell: (command: string, cwd: string) => Promise<string>;
    readonly command: string;
  };
  readonly proposalPromptTemplate?: string;
  readonly applyPromptTemplate?: string;
  /** Advisory prompt prefix (e.g. the hub orientation block) prepended to every loop turn. */
  readonly promptPrefix?: string;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

/**
 * Checkpoint F composition root: assembles the W073 loop from the agent
 * seams. The budget supplier accumulates SUCCESSFUL proposal/apply turn cost
 * only — a turn that throws contributes its spend to the hub's run-usage
 * ledger (recorded in the turn runner's `finally`) but not to this supplier;
 * reviewer/test gate cost is metered by the hub's own run usage, not here.
 * Both granularity gaps are recorded residuals.
 */
export function createAgentDrivenRunLoop(deps: AgentDrivenRunLoopDeps): (spec: SelfImprovementSpec, controls: {
  readonly onIteration: (record: LoopIterationRecord) => void;
  readonly isCancelled: () => boolean;
}) => Promise<LoopOutcome> {
  return async (spec, controls) => {
    const accumulated = { costUsd: 0 };
    const turn: AgentTurnRunner = async (input) => {
      const result = await deps.turn({
        ...input,
        prompt: deps.promptPrefix === undefined ? input.prompt : deps.promptPrefix + input.prompt,
      });
      accumulated.costUsd += result.costUsd;
      return result;
    };
    const objective: LoopObjective = {
      description: spec.objective,
      workspace: spec.workspace,
      requiresReview: spec.requiresReview ?? true,
      ...(deps.measure === undefined
        ? {}
        : { measure: createShellMeasure({ shell: deps.measure.shell, command: deps.measure.command, workspace: spec.workspace }) }),
      ...(spec.direction === undefined ? {} : { direction: spec.direction }),
      ...(spec.baselineScore === undefined ? {} : { baselineScore: spec.baselineScore }),
    };
    const loop = createSelfImprovementLoop({
      objective,
      proposals: createAgentProposalSource({
        turn,
        workspace: spec.workspace,
        ...(deps.proposalPromptTemplate === undefined ? {} : { promptTemplate: deps.proposalPromptTemplate }),
      }),
      workspace: createGitCandidateWorkspace({
        workspace: spec.workspace,
        run: deps.gitRun,
        mutate: createAgentMutator({
          turn,
          objective: spec.objective,
          ...(deps.applyPromptTemplate === undefined ? {} : { promptTemplate: deps.applyPromptTemplate }),
        }),
      }),
      authority: deps.authority,
      limits: {
        maxIterations: spec.maxIterations,
        ...(spec.maxConsecutiveRejections === undefined ? {} : { maxConsecutiveRejections: spec.maxConsecutiveRejections }),
        ...(spec.budgetUsd === undefined ? {} : { budgetUsd: spec.budgetUsd }),
        usageUsd: () => accumulated.costUsd,
      },
      shouldStop: controls.isCancelled,
      onIteration: controls.onIteration,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    return loop.run();
  };
}
