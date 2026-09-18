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
  /** The ACP session id the request arrived under; scopes cancel/filter. */
  readonly sessionKey: string | undefined;
  readonly resolve: (decision: PolicyDecision) => void;
}

/**
 * Operator-controlled overlay on the hub's authorization. Auto mode (the
 * default) passes straight through; ask mode parks every request the policy
 * would otherwise ALLOW as an in-thread prompt card and waits for the
 * operator's answer. Hard policy denials (capability withheld, workspace
 * violations, task gates) never prompt — fail-closed stays fail-closed.
 *
 * Parked requests are keyed per ACP session so parallel agent runtimes each
 * park their own prompts; mode and remembered patterns are operator-global.
 */
export class PermissionBroker {
  #mode: PermissionMode = "auto";
  readonly #alwaysAllow = new Set<string>();
  readonly #alwaysReject = new Set<string>();
  #parked = new Map<string, ParkedRequest>();

  mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
    // Switching back to auto must not leave any parked request dangling.
    this.cancelPending("permission mode switched to auto");
  }

  patterns(): { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[] } {
    return { alwaysAllow: [...this.#alwaysAllow], alwaysReject: [...this.#alwaysReject] };
  }

  /** The parked request awaiting the operator for one session (or the oldest
   * overall when no key is known — the legacy single-session shape). */
  pendingRequest(sessionKey?: string): PendingPermissionRequest | undefined {
    if (sessionKey === undefined) return this.#oldestParked()?.request;
    return this.#parkedFor(sessionKey);
  }

  /** Resolves the parked request; false when the id is unknown or stale. */
  answer(id: string, choice: PermissionDecisionChoice): boolean {
    const parked = this.#parked.get(id);
    if (parked === undefined) return false;
    this.#parked.delete(id);
    const tool = parked.request.tool;
    switch (choice) {
      case "allow_once":
        parked.resolve({ kind: "allow" });
        return true;
      case "allow_always":
        this.#alwaysAllow.add(tool);
        this.#alwaysReject.delete(tool);
        parked.resolve({ kind: "allow" });
        return true;
      case "reject_once":
        parked.resolve({ kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });
        return true;
      case "reject_always":
        this.#alwaysReject.add(tool);
        this.#alwaysAllow.delete(tool);
        parked.resolve({ kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator (always)" });
        return true;
    }
  }

  /** Denies parked requests (turn cancelled, runtime disposed, mode switch).
   * With a session key only that session's prompts resolve; without, all. */
  cancelPending(reason: string, sessionKey?: string): void {
    if (sessionKey === undefined) {
      const all = [...this.#parked.values()];
      this.#parked.clear();
      for (const parked of all) {
        parked.resolve({ kind: "deny", code: "PROMPT_CANCELLED", reason });
      }
      return;
    }
    for (const [id, parked] of this.#parked) {
      if (parked.sessionKey === sessionKey) {
        this.#parked.delete(id);
        parked.resolve({ kind: "deny", code: "PROMPT_CANCELLED", reason });
      }
    }
  }

  /** Clears all stored decisions without touching parked requests. */
  resetPatterns(): void {
    this.#alwaysAllow.clear();
    this.#alwaysReject.clear();
  }

  /**
   * Authorization overlay: policy first (fail-closed), then the operator's
   * stored decisions, then — in ask mode — a parked prompt. Each session
   * parks its own prompt (parallel runtimes are independent); a concurrent
   * second request from the same session fails closed.
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
      // One parked prompt per session (the original fail-closed posture,
      // now scoped per session instead of globally): a concurrent second
      // request from the same session denies rather than queueing.
      if (this.#parkedByActionSession(action.sessionId).length >= 1) {
        return {
          kind: "deny",
          code: "PROMPT_BUSY",
          reason: "a permission prompt from this session is already waiting for the operator",
        };
      }
      return new Promise<PolicyDecision>((resolve) => {
        const request: PendingPermissionRequest = {
          id: `perm-${randomBytes(6).toString("hex")}`,
          tool: action.tool,
          capability: action.capability,
          subjects: [...action.subjects],
          inputPreview: inputPreview(action.input),
        };
        this.#parked.set(request.id, { request, sessionKey: action.sessionId, resolve });
      });
    })();
  }

  #parkedByActionSession(sessionId: string): ParkedRequest[] {
    return [...this.#parked.values()].filter((parked) => parked.sessionKey === sessionId);
  }

  #parkedFor(sessionKey: string): PendingPermissionRequest | undefined {
    return this.#parkedByActionSession(sessionKey)[0]?.request;
  }

  #oldestParked(): ParkedRequest | undefined {
    // Maps iterate in insertion order; the first entry parked first.
    const [entry] = this.#parked.values();
    return entry;
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