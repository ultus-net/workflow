import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

/**
 * W073 — bounded recursive self-improvement loop (the Karpathy loop) under
 * Workflow authority. Spec: `docs/superpowers/plans/2026-09-19-recursive-self-improvement-loop.md`.
 *
 * The loop is a deterministic integration-layer orchestrator. It never grants
 * authority: every candidate is routed through the canonical run lifecycle
 * (`begin` → `finish`), so a candidate can only be committed once the kernel
 * reached `VERIFIED` on fresh evidence (hub tests, and a reviewer when the
 * objective requires one). Rejected candidates are discarded; the loop is
 * bounded by an operator-defined objective, iteration/rejection caps, and an
 * optional cost budget. No model weights and no kernel concepts are touched.
 */

export interface LoopObjective {
  /** Human-defined statement of what "better" means. */
  readonly description: string;
  /** Absolute path to the repository/workspace the loop may change. */
  readonly workspace: string;
  /** Whether each candidate run carries the reviewer evidence requirement. */
  readonly requiresReview: boolean;
  /** Optional scalar measured on the candidate tree after apply. */
  readonly measure?: (input: { readonly iteration: number }) => Promise<number> | number;
  /** Whether a higher or lower score is better. Defaults to "higher". */
  readonly direction?: "higher" | "lower";
  /** Optional incumbent score; without one, the first measured candidate sets it. */
  readonly baselineScore?: number;
}

export interface ImprovementProposal {
  readonly id: string;
  readonly hypothesis: string;
  readonly target?: string;
}

export interface ProposalContext {
  readonly iteration: number;
  readonly objective: string;
  readonly accepted: number;
  readonly rejected: number;
  readonly best: { readonly proposalId: string; readonly score?: number } | undefined;
  readonly history: readonly LoopIterationRecord[];
}

export interface ProposalSource {
  /** The next candidate, or `undefined` when the source is exhausted. */
  next(context: ProposalContext): Promise<ImprovementProposal | undefined>;
}

export interface ApplyResult {
  readonly changed: boolean;
  readonly summary?: string;
}

/**
 * The mutation + git seam. `apply` performs (or observes) the candidate change;
 * `commit` records an accepted change; `discard` returns the workspace to the
 * pre-apply state. The loop never calls `commit` before the canonical run is
 * `VERIFIED`.
 */
export interface CandidateWorkspace {
  /**
   * P0-1 (adversarial review): prove the workspace is a safe baseline BEFORE
   * the first candidate. The git implementation refuses a non-repository and a
   * dirty tree (`git status --porcelain` non-empty, untracked included), so
   * `discard` can only ever revert the loop's own candidate changes — never
   * pre-existing operator work. Throw to fail closed.
   */
  assertBaseline(input: { readonly workspace: string }): Promise<void>;
  apply(input: {
    readonly runId: string;
    readonly workspace: string;
    readonly proposal: ImprovementProposal;
  }): Promise<ApplyResult>;
  commit(input: {
    readonly runId: string;
    readonly workspace: string;
    readonly message: string;
  }): Promise<{ readonly committed: boolean; readonly ref?: string }>;
  discard(input: { readonly runId: string; readonly workspace: string }): Promise<void>;
}

/**
 * The slice of `WorkflowRunController` the loop needs. `WorkflowRunController`
 * satisfies it structurally; `createAuthorityGate` adapts it explicitly.
 */
export interface LoopAuthority {
  begin(input: {
    readonly runId: string;
    readonly title: string;
    readonly workspace: string;
    readonly requiresReview: boolean;
    readonly taskPrompt?: string;
  }): Promise<void>;
  finish(input: { readonly runId: string; readonly outcome: "verified" | "failed" }): Promise<void>;
}

export interface LoopLimits {
  /** Hard cap on iterations; validated as a positive integer. */
  readonly maxIterations: number;
  /** Stop after this many rejected candidates in a row. */
  readonly maxConsecutiveRejections?: number;
  /** Stop once `usageUsd()` reaches this cap. */
  readonly budgetUsd?: number;
  readonly usageUsd?: () => number;
}

export interface LoopIterationRecord {
  readonly iteration: number;
  readonly proposalId: string;
  readonly hypothesis: string;
  readonly changed: boolean;
  readonly runId: string;
  readonly verdict: "accepted" | "rejected";
  readonly reason: string;
  readonly score?: number;
  readonly commitRef?: string;
  readonly observedAt: string;
}

export interface LoopOutcome {
  readonly status: "completed" | "stopped";
  readonly reason: string;
  readonly iterations: readonly LoopIterationRecord[];
  readonly accepted: number;
  readonly rejected: number;
  readonly committed: readonly { readonly runId: string; readonly ref?: string }[];
  readonly best: { readonly proposalId: string; readonly score?: number } | undefined;
}

export interface SelfImprovementLoopOptions {
  readonly objective: LoopObjective;
  readonly proposals: ProposalSource;
  readonly workspace: CandidateWorkspace;
  readonly authority: LoopAuthority;
  readonly limits: LoopLimits;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  readonly onIteration?: (record: LoopIterationRecord) => void;
  /**
   * Cooperative cancellation, checked at each iteration boundary (never
   * mid-candidate): a true result stops the loop before the next proposal.
   * A throwing predicate fails closed (stops). The in-flight candidate always
   * runs to its gate and is committed or discarded normally.
   */
  readonly shouldStop?: () => boolean;
}

export interface SelfImprovementLoop {
  run(): Promise<LoopOutcome>;
}

/** One loop per workspace at a time (I-D): concurrent runs are refused. */
const activeWorkspaces = new Set<string>();

/** Realpath when the path exists, so `/repo`, `/repo/`, and symlink aliases lock the same slot. */
function workspaceKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function createSelfImprovementLoop(options: SelfImprovementLoopOptions): SelfImprovementLoop {
  const { objective, proposals, workspace, authority, limits } = options;
  requireObjective(objective);
  requireLimits(limits);
  const now = options.now ?? ((): Date => new Date());
  const log = options.log ?? ((): void => undefined);
  const direction = objective.direction ?? "higher";

  let baselineScore = objective.baselineScore;
  let best: { proposalId: string; score?: number } | undefined =
    baselineScore === undefined ? undefined : { proposalId: "<baseline>", score: baselineScore };

  const run = async (): Promise<LoopOutcome> => {
    const lockKey = workspaceKey(objective.workspace);
    if (activeWorkspaces.has(lockKey)) {
      throw new TypeError(`a self-improvement loop is already running for workspace ${objective.workspace}`);
    }
    activeWorkspaces.add(lockKey);

    // P0-1: no candidate is proposed until the workspace proves it is a safe
    // baseline. A failed check stops the loop before any authority is engaged.
    try {
      await workspace.assertBaseline({ workspace: objective.workspace });
    } catch (error) {
      activeWorkspaces.delete(lockKey);
      return {
        status: "stopped",
        reason: `workspace baseline check failed (fail closed, no mutation): ${describe(error)}`,
        iterations: [],
        accepted: 0,
        rejected: 0,
        committed: [],
        best,
      };
    }

    const iterations: LoopIterationRecord[] = [];
    const committed: { runId: string; ref?: string }[] = [];
    let accepted = 0;
    let rejected = 0;
    let consecutiveRejections = 0;

    const record = (entry: LoopIterationRecord): void => {
      iterations.push(entry);
      // Observability must never kill the loop; a throwing observer is logged,
      // not propagated (every other failure mode fails closed instead).
      try {
        options.onIteration?.(entry);
      } catch (error) {
        log(`self-improvement loop: onIteration observer failed: ${describe(error)}`);
      }
    };

    const closeFailed = async (runId: string): Promise<string | undefined> => {
      try {
        await authority.finish({ runId, outcome: "failed" });
        return undefined;
      } catch (error) {
        const reason = `run ${runId} could not be closed failed: ${describe(error)}`;
        log(`self-improvement loop: ${reason}`);
        return reason;
      }
    };

    const discard = async (runId: string): Promise<string | undefined> => {
      try {
        await workspace.discard({ runId, workspace: objective.workspace });
        return undefined;
      } catch (error) {
        const reason = `run ${runId} could not be discarded: ${describe(error)}`;
        log(`self-improvement loop: ${reason}`);
        return reason;
      }
    };

    /**
     * Rejects a candidate and returns the rollback failure, if any. A failed
     * close or discard leaves the tree mutated or the run open, so the caller
     * must stop the loop rather than pretend the workspace is clean.
     */
    const reject = async (input: {
      iteration: number;
      proposal: ImprovementProposal;
      runId: string;
      changed: boolean;
      reason: string;
    }): Promise<string | undefined> => {
      const closeFailure = await closeFailed(input.runId);
      const discardFailure = await discard(input.runId);
      rejected += 1;
      consecutiveRejections += 1;
      const rollbackFailures = [closeFailure, discardFailure].filter(
        (failure): failure is string => failure !== undefined,
      );
      const rollbackFailure = rollbackFailures.length === 0 ? undefined : rollbackFailures.join("; ");
      record({
        iteration: input.iteration,
        proposalId: input.proposal.id,
        hypothesis: input.proposal.hypothesis,
        changed: input.changed,
        runId: input.runId,
        verdict: "rejected",
        reason: rollbackFailure === undefined ? input.reason : `${input.reason} (rollback incomplete: ${rollbackFailure})`,
        observedAt: now().toISOString(),
      });
      return rollbackFailure;
    };

    const stopReason = (): string | undefined => {
      if (limits.budgetUsd !== undefined && limits.usageUsd !== undefined) {
        let usage: number;
        try {
          usage = limits.usageUsd();
        } catch (error) {
          return `usage supplier failed (fail closed): ${describe(error)}`;
        }
        if (usage >= limits.budgetUsd) {
          return `budget cap reached ($${usage.toFixed(4)} >= $${limits.budgetUsd.toFixed(4)})`;
        }
      }
      if (limits.maxConsecutiveRejections !== undefined && consecutiveRejections >= limits.maxConsecutiveRejections) {
        return `${consecutiveRejections} consecutive rejections`;
      }
      return undefined;
    };

    const outcome = (status: LoopOutcome["status"], reason: string): LoopOutcome => {
      return { status, reason, iterations: [...iterations], accepted, rejected, committed: [...committed], best };
    };

    /**
     * Rejects a candidate; when the rollback itself failed (run open or tree
     * still mutated) returns a stop outcome instead of continuing as if the
     * workspace were clean.
     */
    const rejectAndContinue = async (input: {
      iteration: number;
      proposal: ImprovementProposal;
      runId: string;
      changed: boolean;
      reason: string;
    }): Promise<LoopOutcome | undefined> => {
      const rollbackFailure = await reject(input);
      if (rollbackFailure === undefined) return undefined;
      return outcome("stopped", `rejected candidate left the workspace unsafe: ${rollbackFailure}`);
    };

    try {
      for (let iteration = 1; iteration <= limits.maxIterations; iteration += 1) {
        const budgetStop = stopReason();
        if (budgetStop !== undefined) {
          return outcome("stopped", budgetStop);
        }
        // Operator cancel is checked only at the iteration boundary: the
        // in-flight candidate completes its gate (commit or discard) before
        // the loop stops, so cancel never aborts mid-mutation.
        if (options.shouldStop !== undefined) {
          let cancelled: boolean;
          try {
            cancelled = options.shouldStop();
          } catch (error) {
            return outcome("stopped", `cancellation check failed (fail closed): ${describe(error)}`);
          }
          if (cancelled) return outcome("stopped", "cancelled by operator");
        }

        let proposal: ImprovementProposal | undefined;
        try {
          proposal = await proposals.next({
            iteration,
            objective: objective.description,
            accepted,
            rejected,
            best,
            history: [...iterations],
          });
        } catch (error) {
          return outcome("stopped", `proposal source failed: ${describe(error)}`);
        }
        if (proposal === undefined) {
          return outcome("completed", "proposal source exhausted");
        }
        if (!isValidProposal(proposal)) {
          return outcome("stopped", "proposal source returned a malformed proposal (fail closed, no mutation)");
        }

        const runId = `rsi:${iteration}:${randomUUID()}`;
        try {
          await authority.begin({
            runId,
            title: `Self-improvement candidate ${proposal.id}`,
            workspace: objective.workspace,
            requiresReview: objective.requiresReview,
            // P1-2 (adversarial review): the run's ask (which the reviewer
            // binds into its provenance fingerprint and rubric context) is the
            // OPERATOR's objective, never the candidate's own hypothesis. The
            // hypothesis stays in the audit record; feeding candidate-authored
            // prose to the only backstop gate would be an injection seam.
            taskPrompt: objective.description,
          });
        } catch (error) {
          return outcome("stopped", `authority refused run begin (fail closed, no mutation): ${describe(error)}`);
        }

        let applied: ApplyResult;
        try {
          applied = await workspace.apply({ runId, workspace: objective.workspace, proposal });
        } catch (error) {
          const stopped = await rejectAndContinue({ iteration, proposal, runId, changed: false, reason: `apply failed: ${describe(error)}` });
          if (stopped !== undefined) return stopped;
          continue;
        }
        if (!applied.changed) {
          const stopped = await rejectAndContinue({
            iteration,
            proposal,
            runId,
            changed: false,
            reason: applied.summary ?? "candidate produced no change",
          });
          if (stopped !== undefined) return stopped;
          continue;
        }

        let score: number | undefined;
        if (objective.measure !== undefined) {
          try {
            score = await objective.measure({ iteration });
          } catch (error) {
            const stopped = await rejectAndContinue({ iteration, proposal, runId, changed: true, reason: `measure failed: ${describe(error)}` });
            if (stopped !== undefined) return stopped;
            continue;
          }
          if (!Number.isFinite(score)) {
            const stopped = await rejectAndContinue({
              iteration,
              proposal,
              runId,
              changed: true,
              reason: `measure returned a non-finite score: ${score}`,
            });
            if (stopped !== undefined) return stopped;
            continue;
          }
          if (baselineScore !== undefined && !improves(score, baselineScore, direction)) {
            const stopped = await rejectAndContinue({
              iteration,
              proposal,
              runId,
              changed: true,
              reason: `score ${score} did not improve on incumbent ${baselineScore} (${direction} is better)`,
            });
            if (stopped !== undefined) return stopped;
            continue;
          }
        }

        try {
          await authority.finish({ runId, outcome: "verified" });
        } catch (error) {
          const stopped = await rejectAndContinue({
            iteration,
            proposal,
            runId,
            changed: true,
            reason: `verification gate refused the candidate: ${describe(error)}`,
          });
          if (stopped !== undefined) return stopped;
          continue;
        }

        let commitRef: string | undefined;
        let commitFailure: string | undefined;
        try {
          const result = await workspace.commit({
            runId,
            workspace: objective.workspace,
            message: `self-improvement(${proposal.id}): ${proposal.hypothesis}`,
          });
          if (!result.committed) {
            commitFailure = `verified candidate ${runId} was not committed (fail closed)`;
          } else {
            commitRef = result.ref;
          }
        } catch (error) {
          commitFailure = `verified candidate ${runId} could not be committed: ${describe(error)}`;
        }
        if (commitFailure !== undefined) {
          // I-G: the candidate verified, but the loop never claims a commit it
          // did not make. Audit it, surface it, and stop — the tree keeps the
          // verified change uncommitted for the operator to resolve.
          record({
            iteration,
            proposalId: proposal.id,
            hypothesis: proposal.hypothesis,
            changed: true,
            runId,
            verdict: "accepted",
            reason: commitFailure,
            ...(score === undefined ? {} : { score }),
            observedAt: now().toISOString(),
          });
          return outcome("stopped", commitFailure);
        }

        accepted += 1;
        consecutiveRejections = 0;
        if (score !== undefined) {
          baselineScore = score;
          best = { proposalId: proposal.id, score };
        } else {
          best = { proposalId: proposal.id };
        }
        committed.push(commitRef === undefined ? { runId } : { runId, ref: commitRef });
        const entry: LoopIterationRecord = {
          iteration,
          proposalId: proposal.id,
          hypothesis: proposal.hypothesis,
          changed: true,
          runId,
          verdict: "accepted",
          reason: "candidate verified and committed",
          ...(score === undefined ? {} : { score }),
          ...(commitRef === undefined ? {} : { commitRef }),
          observedAt: now().toISOString(),
        };
        record(entry);

        // Without a comparator there is nothing more to optimize toward: the
        // first verified candidate is the goal.
        if (objective.measure === undefined) {
          return outcome("completed", "first verified candidate accepted (no comparator declared)");
        }
      }
      return outcome("stopped", `maxIterations (${limits.maxIterations}) reached`);
    } finally {
      // Release the same key acquisition added — the normalized realpath, not
      // the raw declared path (a mismatch would leak the lock forever).
      activeWorkspaces.delete(lockKey);
    }
  };

  return { run };
}

/**
 * Adapts a `WorkflowRunController` (or any structurally compatible object) to
 * the loop's `LoopAuthority` seam. Production wiring point.
 */
export function createAuthorityGate(controller: {
  begin(input: {
    readonly runId: string;
    readonly title: string;
    readonly workspace: string;
    readonly requiresReview: boolean;
    readonly taskPrompt?: string;
  }): Promise<void>;
  finish(input: { readonly runId: string; readonly outcome: "verified" | "failed" }): Promise<void>;
}): LoopAuthority {
  return {
    begin: async (input) => {
      await controller.begin(input);
    },
    finish: async (input) => {
      await controller.finish(input);
    },
  };
}

// ── Git candidate workspace ────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<CommandResult>;

/** Default runner: `execFile` with an argument array (no shell interpretation). */
export function createExecFileRunner(): CommandRunner {
  const exec = promisify(execFile);
  return async (command, args, options) => {
    const { stdout, stderr } = await exec(command, [...args], { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr };
  };
}

/**
 * A `CandidateWorkspace` over a **dedicated** git checkout. `mutate` is the
 * agent seam that changes the tree after the run is authorized; when omitted,
 * `apply` only detects a change an external applier already made. `discard` is
 * destructive to uncommitted work in the workspace — the workspace must be
 * dedicated to the loop (documented residual in the W073 plan).
 */
export function createGitCandidateWorkspace(options: {
  readonly workspace: string;
  readonly run: CommandRunner;
  readonly mutate?: (input: {
    readonly runId: string;
    readonly workspace: string;
    readonly proposal: ImprovementProposal;
  }) => Promise<ApplyResult | void>;
}): CandidateWorkspace {
  if (!isAbsolute(options.workspace)) {
    throw new TypeError(`git candidate workspace must be an absolute path: ${options.workspace}`);
  }
  return {
    async assertBaseline(input) {
      // P0-1: the destructive ops below (reset --hard / clean -fd) are only
      // safe against a tree the loop starts from clean. Refuse anything else.
      let inside: string | undefined;
      try {
        inside = (await options.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: input.workspace })).stdout.trim();
      } catch {
        throw new TypeError(`workspace is not a git repository: ${input.workspace}`);
      }
      if (inside !== "true") {
        throw new TypeError(`workspace is not a git work tree: ${input.workspace}`);
      }
      const status = await options.run("git", ["status", "--porcelain"], { cwd: input.workspace });
      if (status.stdout.trim().length > 0) {
        throw new TypeError(
          `workspace has uncommitted work; a self-improvement loop requires a clean checkout so discard can never destroy operator changes: ${input.workspace}`,
        );
      }
    },
    async apply(input) {
      if (options.mutate !== undefined) {
        const result = await options.mutate(input);
        if (result !== undefined) return result;
      }
      const status = await options.run("git", ["status", "--porcelain"], { cwd: input.workspace });
      return { changed: status.stdout.trim().length > 0 };
    },
    async commit(input) {
      // Refuse silently-empty commits: a verified candidate must have a change.
      await options.run("git", ["add", "-A"], { cwd: input.workspace });
      await options.run("git", ["commit", "-m", input.message], { cwd: input.workspace });
      // The commit itself is the commit; the ref is best-effort. A failed
      // `rev-parse` must not misreport a successful commit as a failure.
      try {
        const rev = await options.run("git", ["rev-parse", "HEAD"], { cwd: input.workspace });
        return { committed: true, ref: rev.stdout.trim() };
      } catch {
        return { committed: true };
      }
    },
    async discard(input) {
      await options.run("git", ["reset", "--hard", "HEAD"], { cwd: input.workspace });
      await options.run("git", ["clean", "-fd"], { cwd: input.workspace });
    },
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

function requireObjective(objective: LoopObjective): void {
  if (objective.description.trim().length === 0) {
    throw new TypeError("loop objective description must be non-empty");
  }
  if (!isAbsolute(objective.workspace)) {
    throw new TypeError(`loop objective workspace must be absolute: ${objective.workspace}`);
  }
  if (objective.direction !== undefined && objective.direction !== "higher" && objective.direction !== "lower") {
    throw new TypeError(`loop objective direction must be 'higher' or 'lower': ${String(objective.direction)}`);
  }
  if (objective.baselineScore !== undefined && !Number.isFinite(objective.baselineScore)) {
    throw new TypeError("loop objective baselineScore must be a finite number");
  }
}

function requireLimits(limits: LoopLimits): void {
  if (!Number.isSafeInteger(limits.maxIterations) || limits.maxIterations <= 0) {
    throw new TypeError("loop limits.maxIterations must be a positive integer");
  }
  if (
    limits.maxConsecutiveRejections !== undefined &&
    (!Number.isSafeInteger(limits.maxConsecutiveRejections) || limits.maxConsecutiveRejections <= 0)
  ) {
    throw new TypeError("loop limits.maxConsecutiveRejections must be a positive integer");
  }
  if (limits.budgetUsd !== undefined && (!Number.isFinite(limits.budgetUsd) || limits.budgetUsd <= 0)) {
    throw new TypeError("loop limits.budgetUsd must be a positive number");
  }
  if (limits.budgetUsd !== undefined && limits.usageUsd === undefined) {
    throw new TypeError("loop limits.budgetUsd requires a usageUsd() supplier");
  }
}

function isValidProposal(proposal: ImprovementProposal): boolean {
  return (
    typeof proposal === "object" &&
    proposal !== null &&
    typeof proposal.id === "string" &&
    proposal.id.trim().length > 0 &&
    typeof proposal.hypothesis === "string" &&
    proposal.hypothesis.trim().length > 0
  );
}

function improves(score: number, incumbent: number, direction: "higher" | "lower"): boolean {
  return direction === "lower" ? score < incumbent : score > incumbent;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
