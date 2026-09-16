import { randomBytes } from "node:crypto";

import type { PolicyDecision } from "../kernel/contracts.js";
import type { ProposedToolAction, ToolCapability } from "../application/host.js";

export type PermissionMode = "auto" | "ask";
export type PermissionDecisionChoice = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** One parked permission request as shown on the prompt card. */
export interface PendingPermissionRequest {
  readonly id: string;
  readonly tool: string;
  readonly capability: ToolCapability | undefined;
  readonly subjects: readonly string[];
  readonly inputPreview: string | undefined;
}

interface ParkedRequest {
  readonly request: PendingPermissionRequest;
  readonly resolve: (decision: PolicyDecision) => void;
}

/**
 * Operator-controlled overlay on the hub's authorization. Auto mode (the
 * default) passes straight through; ask mode parks every request the policy
 * would otherwise ALLOW as an in-thread prompt card and waits for the
 * operator's answer. Hard policy denials (capability withheld, workspace
 * violations, task gates) never prompt — fail-closed stays fail-closed.
 */
export class PermissionBroker {
  #mode: PermissionMode = "auto";
  readonly #alwaysAllow = new Set<string>();
  readonly #alwaysReject = new Set<string>();
  #parked: ParkedRequest | undefined;

  mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
    // Switching back to auto must not leave a parked request dangling.
    this.#resolveParked({ kind: "deny", code: "MODE_RESET", reason: "permission mode switched to auto" });
  }

  patterns(): { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[] } {
    return { alwaysAllow: [...this.#alwaysAllow], alwaysReject: [...this.#alwaysReject] };
  }

  pendingRequest(): PendingPermissionRequest | undefined {
    return this.#parked?.request;
  }

  /** Resolves the parked request; false when the id is unknown or stale. */
  answer(id: string, choice: PermissionDecisionChoice): boolean {
    if (this.#parked === undefined || this.#parked.request.id !== id) return false;
    const tool = this.#parked.request.tool;
    switch (choice) {
      case "allow_once":
        this.#resolveParked({ kind: "allow" });
        return true;
      case "allow_always":
        this.#alwaysAllow.add(tool);
        this.#alwaysReject.delete(tool);
        this.#resolveParked({ kind: "allow" });
        return true;
      case "reject_once":
        this.#resolveParked({ kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });
        return true;
      case "reject_always":
        this.#alwaysReject.add(tool);
        this.#alwaysAllow.delete(tool);
        this.#resolveParked({ kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator (always)" });
        return true;
    }
  }

  /** Denies a parked request (turn cancelled, runtime disposed, mode switch). */
  cancelPending(reason: string): void {
    this.#resolveParked({ kind: "deny", code: "PROMPT_CANCELLED", reason });
  }

  /** Clears all stored decisions without touching a parked request. */
  resetPatterns(): void {
    this.#alwaysAllow.clear();
    this.#alwaysReject.clear();
  }

  /**
   * Authorization overlay: policy first (fail-closed), then the operator's
   * stored decisions, then — in ask mode — a parked prompt. Only one request
   * can be parked at a time; a concurrent second request fails closed.
   */
  intercept(
    action: ProposedToolAction,
    authorize: (action: ProposedToolAction) => PolicyDecision | Promise<PolicyDecision>,
  ): PolicyDecision | Promise<PolicyDecision> {
    if (this.#alwaysReject.has(action.tool)) {
      return Promise.resolve({
        kind: "deny",
        code: "OPERATOR_REJECTED",
        reason: `tool ${action.tool} is always rejected by the operator`,
      });
    }
    if (this.#mode === "auto" || this.#alwaysAllow.has(action.tool)) return authorize(action);
    return (async (): Promise<PolicyDecision> => {
      const decision = await authorize(action);
      if (decision.kind === "deny") return decision;
      if (this.#parked !== undefined) {
        return {
          kind: "deny",
          code: "PROMPT_BUSY",
          reason: "another permission prompt is already waiting for the operator",
        };
      }
      return new Promise<PolicyDecision>((resolve) => {
        this.#parked = {
          request: {
            id: `perm-${randomBytes(6).toString("hex")}`,
            tool: action.tool,
            capability: action.capability,
            subjects: [...action.subjects],
            inputPreview: inputPreview(action.input),
          },
          resolve,
        };
      });
    })();
  }

  #resolveParked(decision: PolicyDecision): void {
    const parked = this.#parked;
    this.#parked = undefined;
    parked?.resolve(decision);
  }
}

/** Compact display text for the prompt card; capped like tool-card I/O. */
function inputPreview(input: unknown): string | undefined {
  let text: string | undefined;
  if (typeof input === "string") {
    text = input.length > 0 ? input : undefined;
  } else if (typeof input === "object" && input !== null) {
    const encoded = JSON.stringify(input, null, 2);
    text = encoded.length === 0 || encoded === "{}" || encoded === "[]" ? undefined : encoded;
  }
  if (text === undefined) return undefined;
  const limit = 2 * 1024;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
