import { randomBytes } from "node:crypto";

import type { PolicyDecision } from "../kernel/contracts.js";
import type { ProposedToolAction, ReadFingerprint, ToolCapability } from "../application/host.js";

export type PermissionMode = "auto" | "ask";
export type PermissionDecisionChoice = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/** W112: the lifecycle record behind one allow_always grant (previously the
 * grant was an immortal, tool-name-wide, in-memory Set entry — nearest
 * building blocks: the opencode-server authority's single-use consumption
 * maps and the provenance-store fingerprint discipline). */
export interface AllowAlwaysGrant {
  readonly tool: string;
  /** Ownership: the ACP session scope that created the grant — a grant
   * auto-allows only actions from that session, never another session's
   * identical tool. */
  readonly sessionId: string;
  /** Expiry recorded at grant time: the bounded TTL as an absolute deadline.
   * A grant auto-allows only while now() < expiresAt — at the boundary it is
   * stale and the request re-asks (fail closed). */
  readonly expiresAt: number;
  /** Consumption accounting (observability): every grant-backed automatic
   * allow increments the counter. */
  readonly consumed: number;
}

/** The broker's patterns state: the legacy tool lists plus (W112) the grant
 * lifecycle records. Additive only — no field may be removed (the W115
 * transport-view discipline governs every surface that relays this). */
export interface PermissionPatterns {
  readonly alwaysAllow: readonly string[];
  readonly alwaysReject: readonly string[];
  readonly grants: readonly AllowAlwaysGrant[];
}

/** Fail-closed grant validation (the provenance-store discipline): a record
 * that is not exactly a well-formed grant is untrusted — dropped at the seed
 * boundary, and it can never auto-allow. */
export function isAllowAlwaysGrant(value: unknown): value is AllowAlwaysGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.tool) &&
    isNonEmptyString(record.sessionId) &&
    typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) &&
    typeof record.consumed === "number" && Number.isInteger(record.consumed) && record.consumed >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Default bounded TTL recorded on every grant (a day). */
const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PermissionBrokerOptions {
  /** Injectable clock (tests); expiry is judged against it. */
  readonly now?: (() => number) | undefined;
  /** The bounded TTL recorded at grant time. Default 24h. */
  readonly grantTtlMs?: number | undefined;
  /** Grant records to seed (a restore/validation seam). Malformed entries are
   * dropped fail-closed — they can never auto-allow. */
  readonly grants?: readonly unknown[] | undefined;
}

/** One parked permission request as shown on the prompt card.
 * W112 (amux C5): the card renders the COMPLETE proposal payload — the
 * broker retains the full action at parking time (it is in scope there), so
 * the surface no longer truncates it to a 2 KiB preview. The preview stays
 * as the compact form; the inspection cap and the not-approvable-with-
 * reason discipline live in the card. */
export interface PendingPermissionRequest {
  readonly id: string;
  readonly tool: string;
  readonly capability: ToolCapability | undefined;
  readonly subjects: readonly string[];
  readonly inputPreview: string | undefined;
  /** W112: the full untruncated request input (the amux "complete payload").
   * Present whenever the action carried one; the card renders it up to the
   * inspection cap and refuses approval beyond it. */
  readonly input: unknown;
  /** W115: set once at parking when the payload exceeds the approval card's
   * 64 KiB inspection cap (the same measure the card renders). The poll
   * transport strips `input` for flagged requests — the flag keeps the card
   * NOT-APPROVABLE-WITH-REASON without the payload. */
  readonly inputOverCap: boolean;
  /** W112: the proposal's authorization-relevant metadata, previously
   * dropped at parking. */
  readonly taskId: string | undefined;
  readonly mutating: boolean | undefined;
  readonly requiredCapabilities: readonly string[];
  readonly readFingerprints: readonly string[];
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
 * park their own prompts; mode and the always-reject list are operator-global.
 * W112: an allow_always grant is lifecycle-bound — a bounded expiry recorded
 * at grant time, the owning session scope, and a consumption counter exposed
 * through patterns(); unknown, stale, malformed, or foreign-session grant
 * state re-asks (fail closed).
 */
export class PermissionBroker {
  #mode: PermissionMode = "auto";
  /** W112: tool name -> lifecycle record (was an immortal Set of tool names). */
  readonly #alwaysAllow = new Map<string, AllowAlwaysGrant>();
  readonly #alwaysReject = new Set<string>();
  #parked = new Map<string, ParkedRequest>();
  readonly #now: () => number;
  readonly #grantTtlMs: number;

  constructor(options: PermissionBrokerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    const ttl = options.grantTtlMs;
    this.#grantTtlMs = typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_GRANT_TTL_MS;
    for (const record of options.grants ?? []) {
      if (isAllowAlwaysGrant(record)) this.#alwaysAllow.set(record.tool, record);
    }
  }

  mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
    // Switching back to auto must not leave any parked request dangling.
    this.cancelPending("permission mode switched to auto");
  }

  /** The operator's stored decisions: the legacy tool lists plus (W112) the
   * grant lifecycle records. `alwaysAllow` lists LIVE grants only; an expired
   * record stays in `grants` as history until replaced or reset. */
  patterns(): PermissionPatterns {
    const grants = [...this.#alwaysAllow.values()];
    return {
      alwaysAllow: grants.filter((grant) => this.#now() < grant.expiresAt).map((grant) => grant.tool),
      alwaysReject: [...this.#alwaysReject],
      grants,
    };
  }

  /** The parked request awaiting the operator for one session (or the oldest
   * overall when no key is known — the legacy single-session shape). */
  pendingRequest(sessionKey?: string): PendingPermissionRequest | undefined {
    if (sessionKey === undefined) return this.#oldestParked()?.request;
    return this.#parkedFor(sessionKey);
  }

  /** Resolves the parked request; false when the id is unknown or stale, or
   * (W141) when a caller-scoped sessionKey does not OWN the parked request —
   * a session-scoped poll must not let another session's route consume its
   * park. `sessionKey === undefined` keeps the legacy unscoped shape (the
   * keyless channel's poll surfaces the oldest parked request OVERALL, so
   * what it shows is what it may answer). */
  answer(id: string, choice: PermissionDecisionChoice, sessionKey?: string): boolean {
    const parked = this.#parked.get(id);
    if (parked === undefined) return false;
    if (sessionKey !== undefined && parked.sessionKey !== sessionKey) return false;
    this.#parked.delete(id);
    const tool = parked.request.tool;
    switch (choice) {
      case "allow_once":
        parked.resolve({ kind: "allow" });
        return true;
      case "allow_always": {
        // W112: the grant records the parked session as its owner plus the
        // bounded TTL. A park without a session scope records no grant — it
        // could not be owned (fail closed).
        const owner = parked.sessionKey;
        if (typeof owner === "string" && owner.length > 0) {
          this.#alwaysAllow.set(tool, {
            tool,
            sessionId: owner,
            expiresAt: this.#now() + this.#grantTtlMs,
            consumed: 0,
          });
        }
        this.#alwaysReject.delete(tool);
        parked.resolve({ kind: "allow" });
        return true;
      }
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
    if (this.#mode === "auto") return authorize(action);
    // W112: a live, same-session grant bypasses the prompt — never the policy.
    // Stale (expired), foreign-session, or otherwise unknown grant state falls
    // through to the ask path: nothing auto-allows on ambiguity.
    const grant = this.#liveAllowGrant(action);
    if (grant !== undefined) {
      this.#alwaysAllow.set(action.tool, { ...grant, consumed: grant.consumed + 1 });
      return authorize(action);
    }
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
      const classified = classifyInput(action.input);
      return new Promise<PolicyDecision>((resolve) => {
        const request: PendingPermissionRequest = {
          id: `perm-${randomBytes(6).toString("hex")}`,
          tool: action.tool,
          capability: action.capability,
          subjects: [...action.subjects],
          inputPreview: classified.preview,
          // W112 (amux C5): the FULL payload is retained at parking (it is in
          // scope here) — the card renders the complete proposal instead of
          // the 2 KiB preview alone.
          input: action.input,
          inputOverCap: classified.overCap,
          taskId: action.taskId,
          mutating: action.mutating,
          requiredCapabilities: [...(action.requiredCapabilities ?? [])],
          readFingerprints: [...(action.readFingerprints ?? []).map((fingerprint: ReadFingerprint) => fingerprint.path)],
        };
        this.#parked.set(request.id, { request, sessionKey: action.sessionId, resolve });
      });
    })();
  }

  /** The grant for this action when it is live: well-formed (by construction
   * at the answer and seed boundaries), owned by the action's session, and
   * not past its recorded expiry (the boundary itself is stale — fail closed). */
  #liveAllowGrant(action: ProposedToolAction): AllowAlwaysGrant | undefined {
    const grant = this.#alwaysAllow.get(action.tool);
    if (grant === undefined) return undefined;
    if (grant.sessionId !== action.sessionId) return undefined;
    if (this.#now() >= grant.expiresAt) return undefined;
    return grant;
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

/** W115: one parking-time pass over the payload — the compact preview text
 * (capped like tool-card I/O) and the over-cap classification against the
 * approval card's 64 KiB inspection cap (the SAME measure the card renders:
 * strings by length, objects by the pretty-printed JSON length), so the
 * transport strip and NOT-APPROVABLE-WITH-REASON are one classification. */
function classifyInput(input: unknown): { readonly preview: string | undefined; readonly overCap: boolean } {
  let text: string | undefined;
  if (typeof input === "string") {
    text = input.length > 0 ? input : undefined;
  } else if (typeof input === "object" && input !== null) {
    const encoded = JSON.stringify(input, null, 2);
    text = encoded.length === 0 || encoded === "{}" || encoded === "[]" ? undefined : encoded;
  }
  if (text === undefined) return { preview: undefined, overCap: false };
  const overCap = text.length > 64 * 1024;
  const limit = 2 * 1024;
  return { preview: text.length > limit ? `${text.slice(0, limit)}…` : text, overCap };
}