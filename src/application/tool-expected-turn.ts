/**
 * W070b slice 4b: bounded tool-expected-turn detection (harness steering).
 *
 * While a mutation-scoped task is IN_PROGRESS, a turn that produces no tool
 * call means the model narrated instead of acting. The harness may inject a
 * bounded corrective re-prompt (default: at most 2), then surface the stall to
 * the operator. This is a behavioral nudge for open models, NOT a security
 * control and NOT a guarantee: it steers, it never prevents. Kernel evidence
 * gates remain the authority on whether tool usage happened where it counts.
 */

export interface ToolExpectedTurnScope {
  readonly mutationScoped: boolean;
  readonly taskInProgress: boolean;
}

export interface ToolExpectedTurnStats {
  readonly toolTurns: number;
  readonly noToolTurns: number;
  readonly reprompts: number;
  readonly escalations: number;
}

export type ToolExpectedTurnDecision =
  | { readonly action: "none" }
  | { readonly action: "re-prompt"; readonly attempt: number; readonly prompt: string }
  | { readonly action: "escalate"; readonly attempts: number; readonly message: string };

export interface ToolExpectedTurnSteering {
  /** Observes one completed turn; returns the bounded corrective action. */
  readonly observe: (turn: { readonly hadToolCall: boolean }) => ToolExpectedTurnDecision;
  readonly stats: () => ToolExpectedTurnStats;
  readonly reset: () => void;
}

export const DEFAULT_TOOL_EXPECTED_MAX_RETRIES = 2;

export function correctivePrompt(expectedToolClass: string, attempt: number, maxRetries: number): string {
  return (
    `No tool call was made this turn. The active task is mutation-scoped and in progress. ` +
    `Call the expected tool class now: ${expectedToolClass}. ` +
    `(Corrective re-prompt ${attempt}/${maxRetries}.)`
  );
}

export function createToolExpectedTurnSteering(options: {
  readonly scope: () => ToolExpectedTurnScope;
  readonly expectedToolClass?: string;
  readonly maxRetries?: number;
}): ToolExpectedTurnSteering {
  const maxRetries = options.maxRetries ?? DEFAULT_TOOL_EXPECTED_MAX_RETRIES;
  const expectedToolClass = options.expectedToolClass ?? "a mutation tool (edit/write/apply_patch)";
  let attempts = 0;
  let stats: ToolExpectedTurnStats = { toolTurns: 0, noToolTurns: 0, reprompts: 0, escalations: 0 };

  return {
    observe(turn) {
      if (turn.hadToolCall) {
        attempts = 0;
        stats = { ...stats, toolTurns: stats.toolTurns + 1 };
        return { action: "none" };
      }
      stats = { ...stats, noToolTurns: stats.noToolTurns + 1 };
      const scope = options.scope();
      if (!scope.mutationScoped || !scope.taskInProgress) return { action: "none" };
      if (attempts < maxRetries) {
        attempts += 1;
        stats = { ...stats, reprompts: stats.reprompts + 1 };
        return { action: "re-prompt", attempt: attempts, prompt: correctivePrompt(expectedToolClass, attempts, maxRetries) };
      }
      stats = { ...stats, escalations: stats.escalations + 1 };
      return {
        action: "escalate",
        attempts,
        message: `Tool-expected turn: ${attempts} corrective re-prompts made without a tool call on a mutation-scoped in-progress task; surfacing to the operator.`,
      };
    },
    stats: () => ({ ...stats }),
    reset() {
      attempts = 0;
      stats = { toolTurns: 0, noToolTurns: 0, reprompts: 0, escalations: 0 };
    },
  };
}
