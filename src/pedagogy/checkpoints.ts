import type { PedagogicalMode } from "./contracts.js";

export const CHECKPOINT_KINDS = ["learning", "decision", "inspection"] as const;

export type CheckpointKind = typeof CHECKPOINT_KINDS[number];

export type CheckpointStatus = "pending" | "approved";

export interface Checkpoint {
  readonly id: string;
  readonly taskId: string;
  readonly kind: CheckpointKind;
  readonly summary: string;
  status: CheckpointStatus;
}

export interface CheckpointLedger {
  readonly mode: PedagogicalMode;
  readonly maxSocraticInterventionsPerTask: number;
  readonly checkpoints: Map<string, Checkpoint>;
  readonly interventionsByTask: Map<string, number>;
}

export interface CheckpointLedgerOptions {
  readonly maxSocraticInterventionsPerTask?: number;
}

const DEFAULT_SOCRATIC_BUDGET = 3;

/**
 * Mode gating rules from the spec section 2 "Mutation Gating" column:
 * - learn-to-code: learning checkpoints gate before AND during edits.
 * - socratic-tutor: candidate learning checkpoints gate, within an intervention budget.
 * - co-architect: an approved decision checkpoint gates consequential mutation.
 * - walkthrough: human inspection gates the move to VERIFYING (not mutation).
 * - autonomous: nothing gates; standard Workflow authorization applies.
 */
export function requireCheckpoint(mode: PedagogicalMode, kind: CheckpointKind): boolean {
  switch (mode) {
    case "learn-to-code":
    case "socratic-tutor":
      return kind === "learning";
    case "co-architect":
      return kind === "decision";
    case "walkthrough":
      return kind === "inspection";
    case "autonomous":
      return false;
  }
}

export function createCheckpointLedger(
  mode: PedagogicalMode,
  options: CheckpointLedgerOptions = {},
): CheckpointLedger {
  return {
    mode,
    maxSocraticInterventionsPerTask: options.maxSocraticInterventionsPerTask ?? DEFAULT_SOCRATIC_BUDGET,
    checkpoints: new Map(),
    interventionsByTask: new Map(),
  };
}

export function openCheckpoint(
  ledger: CheckpointLedger,
  input: { readonly id: string; readonly taskId: string; readonly kind: CheckpointKind; readonly summary: string },
): Checkpoint {
  if (ledger.checkpoints.has(input.id)) throw new TypeError(`duplicate checkpoint: ${input.id}`);
  const checkpoint: Checkpoint = { ...input, status: "pending" };
  ledger.checkpoints.set(input.id, checkpoint);
  return checkpoint;
}

export function approveCheckpoint(ledger: CheckpointLedger, id: string): Checkpoint {
  const checkpoint = ledger.checkpoints.get(id);
  if (checkpoint === undefined) throw new TypeError(`unknown checkpoint: ${id}`);
  if (checkpoint.status !== "pending") throw new TypeError(`checkpoint ${id} is not pending`);
  checkpoint.status = "approved";
  if (ledger.mode === "socratic-tutor" && checkpoint.kind === "learning") {
    const used = ledger.interventionsByTask.get(checkpoint.taskId) ?? 0;
    ledger.interventionsByTask.set(checkpoint.taskId, used + 1);
  }
  return checkpoint;
}

/**
 * Returns the pending checkpoint currently blocking mutation on `taskId`,
 * or undefined when mutation may proceed.
 */
export function mutationGate(ledger: CheckpointLedger, taskId: string): Checkpoint | undefined {
  if (ledger.mode === "autonomous" || ledger.mode === "walkthrough") return undefined;
  const kind: CheckpointKind = ledger.mode === "co-architect" ? "decision" : "learning";
  if (!requireCheckpoint(ledger.mode, kind)) return undefined;
  if (ledger.mode === "socratic-tutor") {
    const used = ledger.interventionsByTask.get(taskId) ?? 0;
    if (used >= ledger.maxSocraticInterventionsPerTask) return undefined;
  }
  for (const checkpoint of ledger.checkpoints.values()) {
    if (checkpoint.taskId === taskId && checkpoint.kind === kind && checkpoint.status === "pending") {
      return checkpoint;
    }
  }
  return undefined;
}

/**
 * Returns the pending inspection checkpoint blocking the transition to
 * VERIFYING on `taskId`, or undefined when the transition may proceed.
 */
export function verifyingGate(ledger: CheckpointLedger, taskId: string): Checkpoint | undefined {
  if (!requireCheckpoint(ledger.mode, "inspection")) return undefined;
  for (const checkpoint of ledger.checkpoints.values()) {
    if (checkpoint.taskId === taskId && checkpoint.kind === "inspection" && checkpoint.status === "pending") {
      return checkpoint;
    }
  }
  return undefined;
}
