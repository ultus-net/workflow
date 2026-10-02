import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { EgressPolicy, EgressRule } from "./egress-policy.js";
import {
  createOperatorAskHold,
  type OperatorAskHold,
  type OperatorAskReply,
} from "./operator-ask-hold.js";

/**
 * W182 (NVIDIA adoption wave A7): the hub-scoped durable policy revision store
 * behind operator approval on egress deny.
 *
 * OpenShell's network-policy flow: a denied egress surfaces to the operator; an
 * approval merges a **durable policy revision** that survives a restart of one
 * hub instance but resets when the backing session/sandbox is recreated; the
 * baseline policy file is never rewritten ("live policy is the only state").
 *
 * Composition (do not overclaim):
 *
 * - The park/answer dialect is `operator-ask-hold.ts`, reused verbatim — this
 *   module wraps it, it does not fork a second hold. An approval resolves the
 *   hold `once`; a deny or a park timeout resolves `reject` (fail closed), so
 *   an unanswered ask never loosens policy.
 * - A revision is merged only after a **re-check against current policy +
 *   providers at merge time** (the epoch discipline the review-provenance lane
 *   already applies). A policy version or provider-binding change between the
 *   park and the answer invalidates the park: no revision is merged and the
 *   hold resolves `reject` (tighten-never-loosen).
 * - The store persists ONLY its own revision journal. The baseline policy is a
 *   read-only input; `currentPolicy()` composes baseline + revisions, and the
 *   baseline file/object is never written or mutated.
 * - **Reset on recreate**: revisions are tagged with a `generation` — the
 *   backing session/sandbox identity. A restart with the same generation keeps
 *   the loaded revisions; a new generation filters them out (reset) before the
 *   next merge persists.
 *
 * Approval machinery is NOT an enforcement claim: a merged revision is a
 * durable *rule* the proxy may consult. Whether the proxy enforces it is the
 * proxy policy tier's concern (W180, issue #440). As of W184 the W180
 * `egress_policy` denial IS routed through W182's shared `onEgressDenied`
 * event, so this store's one approvable family (`egress_policy` +
 * `no_matching_rule`) is produced end-to-end when a hub composes a policy and
 * the denial sink. The park/merge mechanism is still bounded: no revision can
 * override an explicit `enforce` deny, and a store composed without a live
 * fingerprint source (a standalone unit) simply cannot exercise the epoch.
 */

/** Value-free destination facts for a proposed rule. Never a secret, a
 * placeholder value, or a query string. */
export interface EgressRuleProposal {
  /** The value-free policy family that denied the request (e.g. `egress_policy`). */
  readonly policy: string;
  /** A value-free reason (e.g. `no_matching_rule`); never carries request content. */
  readonly reason: string;
  readonly host: string;
  readonly port?: number;
  readonly method?: string;
  /** Pathname only; the query string is already stripped by the caller. */
  readonly pathname: string;
}

/** The current policy/provider identity a park is bound to. A change between
 * park and answer invalidates the park (no stale approvals). */
export interface EgressPolicyFingerprint {
  /** The live policy revision the park was proposed against. */
  readonly policyVersion: number;
  /** A value-free digest of the live credential/provider bindings. */
  readonly providerFingerprint: string;
}

/** A merged, durable rule. */
export interface EgressPolicyRevision {
  readonly revision: number;
  readonly generation: string;
  readonly ruleId: string;
  readonly host: string;
  readonly port?: number;
  readonly methods: readonly string[];
  readonly paths: readonly string[];
  /** The value-free policy family the revision loosens (observability only). */
  readonly proposedPolicy: string;
  readonly approvedAt: string;
}

/** A parked, redacted proposal visible to the operator surface. */
export interface PendingEgressRule {
  readonly requestId: string;
  readonly proposal: EgressRuleProposal;
  readonly fingerprint: EgressPolicyFingerprint;
  readonly parkedAt: string;
  /**
   * Whether an approval could merge a durable revision. A policy denial
   * (`egress_policy` + `no_matching_rule`) is approvable; a credential-custody
   * refusal (foreign credential, endpoint mismatch) is parked for visibility
   * but is NEVER approvable by an egress rule.
   */
  readonly approvable: boolean;
}

export type EgressAnswerStatus = "merged" | "invalidated" | "denied" | "unknown" | "not-approvable";

export interface EgressAnswerResult {
  readonly status: EgressAnswerStatus;
  /** The merged revision number when `status === "merged"`. */
  readonly revision?: number;
  /** Why an approval was invalidated (`status === "invalidated"`). */
  readonly reason?: string;
}

export interface RecordEgressDenialResult {
  readonly parked: boolean;
  readonly requestId?: string;
  readonly approvable: boolean;
  /** Why a denial did not park as approvable (only credential-custody families). */
  readonly reason?: string;
}

export interface EgressPolicyRevisionStore {
  /**
   * The denial sink: parks a proxy denial as a redacted pending entry (operator
   * visibility). Only a deny-by-default policy denial (`egress_policy` +
   * `no_matching_rule`) is `approvable`; a credential-custody refusal (foreign
   * credential, endpoint mismatch) parks with `approvable: false` and its
   * approval fails closed (`not-approvable`). Only the credential-custody family
   * is produced end-to-end today — the approvable family's emitter is W180's
   * separate policy tier (issue #440), pending.
   */
  recordDenial(event: EgressRuleProposal): RecordEgressDenialResult;
  /**
   * Parks a proposal directly (the primitive the denial sink uses and tests
   * exercise). Resolves `once` on approval, `reject` on deny or timeout.
   */
  park(proposal: EgressRuleProposal): Promise<OperatorAskReply>;
  /**
   * Records the operator's answer. An approval is re-checked against current
   * policy + providers: a stale park is invalidated (`reject`, no merge).
   */
  answer(requestId: string, decision: "allow" | "deny" | OperatorAskReply): EgressAnswerResult;
  pending(): readonly PendingEgressRule[];
  revisions(): readonly EgressPolicyRevision[];
  /** Baseline rules composed with the durable revisions, a fresh object each call. */
  currentPolicy(): EgressPolicy;
  /** The backing session/sandbox generation revisions are scoped to. */
  readonly generation: string;
  /** Clears revisions when the backing session/sandbox is recreated (back to baseline). */
  resetForRecreate(generation: string): void;
  /** Resolves every pending hold to reject, fail closed. */
  cancelAll(): void;
  readonly pendingCount: number;
}

export interface EgressPolicyRevisionStoreOptions {
  readonly path: string;
  /** The read-only baseline policy; never written by this store. */
  readonly baseline: EgressPolicy;
  /** The backing session/sandbox generation (reset key). */
  readonly generation: string;
  /** Live fingerprint supplier (policy version + provider digest), read at merge time. */
  readonly fingerprint: () => EgressPolicyFingerprint;
  /** Hold window for a parked proposal; default 120s (the shared dialect's default). */
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly now?: () => number;
}

/**
 * The value-free requestId: a content digest of the destination facts plus a
 * short random suffix so repeated denials for the same destination do not
 * collide on one pending slot. No query string, secret, or placeholder enters.
 */
function proposalRequestId(proposal: EgressRuleProposal, randomSuffix: string): string {
  const key = [
    proposal.policy,
    proposal.reason,
    proposal.host,
    proposal.port === undefined ? "" : String(proposal.port),
    proposal.method ?? "",
    proposal.pathname,
  ].join("\u0000");
  return `egress-${digest(key)}-${randomSuffix}`;
}

function digest(value: string): string {
  // A tiny, dependency-free stable hash (FNV-1a, 32-bit). This is an identity
  // tag for a value-free key, not a security boundary; the requestId is never
  // a credential and never leaves the hub.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The default approvable family: only the deny-by-default `no_matching_rule`
 * case is operator-approvable. An explicit `enforce` deny is never loosened. */
export function isApprovableEgressDenial(event: EgressRuleProposal): boolean {
  return event.policy === "egress_policy" && event.reason === "no_matching_rule";
}

/** Strip a query/fragment from a path, leaving only the pathname. */
function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut < 0 ? path : path.slice(0, cut);
}

/** Redact a proposal: pathname only (query stripped), bounded string fields. */
function redactProposal(proposal: EgressRuleProposal): EgressRuleProposal {
  return {
    policy: proposal.policy,
    reason: proposal.reason,
    host: proposal.host,
    ...(proposal.port === undefined ? {} : { port: proposal.port }),
    ...(proposal.method === undefined ? {} : { method: proposal.method }),
    pathname: stripQuery(proposal.pathname),
  };
}

function revisionToRule(revision: EgressPolicyRevision): EgressRule {
  return {
    id: revision.ruleId,
    host: revision.host,
    ...(revision.port === undefined ? {} : { port: revision.port }),
    ...(revision.methods.length === 0 ? {} : { methods: revision.methods }),
    ...(revision.paths.length === 0 ? {} : { paths: revision.paths }),
    mode: "enforce",
  };
}

export function createEgressPolicyRevisionStore(
  options: EgressPolicyRevisionStoreOptions,
): EgressPolicyRevisionStore {
  const now = options.now ?? (() => Date.now());
  const hold: OperatorAskHold = createOperatorAskHold(
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  const loaded = loadRevisionsTable(options.path);
  let generation = options.generation;
  // Reset-on-recreate: only revisions matching the current generation survive
  // in memory. A restart with the same generation keeps them; a new generation
  // filters them out (and the reset is persisted immediately, so the journal
  // never names a stale generation) before any merge.
  let revisions: EgressPolicyRevision[] = loaded.generation === generation
    ? [...loaded.revisions]
    : [];
  // Persist the reset only when a journal actually named another generation; a
  // first boot with no journal writes nothing (the empty in-memory state is
  // already correct).
  if (loaded.generation !== "" && loaded.generation !== generation) {
    saveRevisionsTable(options.path, generation, []);
  }
  const proposals = new Map<string, PendingEgressRule>();
  // The parked-proposal set is bounded (the repo's bounded-journal posture): a
  // denial flood must not grow the operator surface without limit. The oldest
  // entry drops past the bound, and its hold is canceled (fail closed) so no
  // ask dangles.
  const PENDING_LIMIT = 64;
  const dropOldestPending = (): void => {
    while (proposals.size > PENDING_LIMIT) {
      const oldest = proposals.keys().next().value;
      if (oldest === undefined) break;
      proposals.delete(oldest);
      hold.answer(oldest, "reject");
    }
  };
  // The ids whose park promise has already been resolved by an explicit
  // `answer`, so the async park continuation never double-merges.
  const answered = new Set<string>();

  const persist = (next: readonly EgressPolicyRevision[]): void => {
    saveRevisionsTable(options.path, generation, next);
    revisions = [...next];
  };

  const currentFingerprint = (): EgressPolicyFingerprint => options.fingerprint();

  const attemptMerge = (pending: PendingEgressRule): EgressAnswerResult => {
    if (!pending.approvable) {
      // A credential-custody refusal is not a policy rule the operator can
      // approve: the refusal stands (fail closed).
      proposals.delete(pending.requestId);
      return { status: "not-approvable", reason: "the denial is not operator-approvable by an egress rule" };
    }
    const current = currentFingerprint();
    if (
      current.policyVersion !== pending.fingerprint.policyVersion ||
      current.providerFingerprint !== pending.fingerprint.providerFingerprint
    ) {
      // The policy or provider bindings moved between the ask and the answer —
      // the approval is stale and must not merge (fail closed).
      proposals.delete(pending.requestId);
      return {
        status: "invalidated",
        reason: "policy or provider bindings changed between ask and answer",
      };
    }
    const revisionNumber = revisions.reduce((max, revision) => Math.max(max, revision.revision), 0) + 1;
    const revision: EgressPolicyRevision = {
      revision: revisionNumber,
      generation,
      ruleId: `revision:${generation}:${revisionNumber}`,
      host: pending.proposal.host,
      ...(pending.proposal.port === undefined ? {} : { port: pending.proposal.port }),
      methods: pending.proposal.method === undefined ? [] : [pending.proposal.method],
      paths: [pending.proposal.pathname],
      proposedPolicy: pending.proposal.policy,
      approvedAt: new Date(now()).toISOString(),
    };
    persist([...revisions, revision]);
    proposals.delete(pending.requestId);
    return { status: "merged", revision: revisionNumber };
  };

  const parkWithId = (proposal: EgressRuleProposal): { requestId: string; reply: Promise<OperatorAskReply> } => {
    const redacted = redactProposal(proposal);
    const requestId = proposalRequestId(redacted, randomBytes(3).toString("hex"));
    const pending: PendingEgressRule = {
      requestId,
      proposal: redacted,
      fingerprint: currentFingerprint(),
      parkedAt: new Date(now()).toISOString(),
      approvable: isApprovableEgressDenial(redacted),
    };
    proposals.set(requestId, pending);
    dropOldestPending();
    const reply = hold.park({ requestId, policy: redacted.policy, reason: redacted.reason });
    void reply.then((resolved) => {
      // A `once` reply that reached the hold without an explicit `answer`
      // (the early-reply race) still re-checks at merge time; a `reject`
      // (deny or timeout) drops the proposal, fail closed.
      if (answered.delete(requestId)) return;
      const held = proposals.get(requestId);
      if (held === undefined) return;
      if (resolved === "once") attemptMerge(held);
      else proposals.delete(requestId);
    }).catch(() => {
      proposals.delete(requestId);
    });
    return { requestId, reply };
  };

  const park = (proposal: EgressRuleProposal): Promise<OperatorAskReply> => parkWithId(proposal).reply;

  return {
    recordDenial(event: EgressRuleProposal): RecordEgressDenialResult {
      // Every proxy denial is parked for operator VISIBILITY, redacted the same
      // way (the W179/W181 discipline). Only a deny-by-default policy denial is
      // operator-APPROVABLE — a foreign-credential or endpoint-mismatch refusal
      // is credential custody, never loosened by an egress rule (its `allow`
      // answers `not-approvable`, fail closed).
      const approvable = isApprovableEgressDenial(event);
      const { requestId } = parkWithId(event);
      return {
        parked: true,
        requestId,
        approvable,
        ...(approvable ? {} : { reason: "the denial is observable but not operator-approvable by an egress rule" }),
      };
    },
    park,
    answer(requestId, decision) {
      const pending = proposals.get(requestId);
      if (pending === undefined) {
        // Unknown/stale id (or a reply that raced ahead of the park): delegate
        // to the shared dialect so the early-reply discipline is preserved. No
        // revision can merge from an id the store never parked.
        hold.answer(requestId, decision);
        return { status: "unknown" };
      }
      if (decision === "deny" || decision === "reject") {
        answered.add(requestId);
        proposals.delete(requestId);
        hold.answer(requestId, "reject");
        return { status: "denied" };
      }
      // An approval: re-check at merge time, mark answered BEFORE resolving so
      // the park continuation cannot double-merge, then resolve the hold.
      const outcome = attemptMerge(pending);
      answered.add(requestId);
      hold.answer(requestId, outcome.status === "merged" ? "once" : "reject");
      return outcome;
    },
    pending(): readonly PendingEgressRule[] {
      return [...proposals.values()].map((entry) => ({
        ...entry,
        proposal: { ...entry.proposal },
        fingerprint: { ...entry.fingerprint },
      }));
    },
    revisions(): readonly EgressPolicyRevision[] {
      return revisions.map((revision) => ({
        ...revision,
        methods: [...revision.methods],
        paths: [...revision.paths],
      }));
    },
    currentPolicy(): EgressPolicy {
      return {
        version: (options.baseline.version ?? 0) + revisions.length,
        rules: [...options.baseline.rules, ...revisions.map(revisionToRule)],
      };
    },
    get generation(): string {
      return generation;
    },
    resetForRecreate(nextGeneration: string): void {
      // Capture the CURRENT generation before reassigning: the persist gate must
      // compare against what the store is actually scoped to now. The
      // construction-time `loaded.generation` goes stale after the first reset
      // (it keeps naming the pre-restart journal), so gating on it could skip a
      // needed clear or write spuriously.
      const previousGeneration = generation;
      generation = nextGeneration;
      // A recreate abandons every pending ask (fail closed) and resets the
      // durable revisions to the baseline.
      for (const requestId of [...proposals.keys()]) hold.answer(requestId, "reject");
      proposals.clear();
      answered.clear();
      if (previousGeneration !== nextGeneration || revisions.length > 0) {
        persist([]);
      }
    },
    cancelAll(): void {
      hold.cancelAll();
      proposals.clear();
    },
    get pendingCount(): number {
      return proposals.size;
    },
  };
}

// ── Persisted revision journal ──────────────────────────────────────────────

interface RevisionsTable {
  readonly version: 1;
  readonly generation: string;
  readonly revisions: readonly EgressPolicyRevision[];
}

export function loadRevisionsTable(path: string): { generation: string; revisions: readonly EgressPolicyRevision[] } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Only an absent journal means "no revisions". A permission or type error
    // must not silently disable the store (mirrors project-registry.ts).
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { generation: "", revisions: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`invalid egress revision journal: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new TypeError("invalid egress revision journal: unsupported or missing version");
  }
  const generation = (parsed as { generation?: unknown }).generation;
  if (typeof generation !== "string") throw new TypeError("invalid egress revision journal: generation must be a string");
  const revisions = (parsed as { revisions?: unknown }).revisions;
  if (!Array.isArray(revisions)) throw new TypeError("invalid egress revision journal: revisions must be an array");
  return { generation, revisions: revisions.map((entry) => requireRevision(entry)) };
}

export function saveRevisionsTable(path: string, generation: string, revisions: readonly EgressPolicyRevision[]): void {
  const table: RevisionsTable = { version: 1, generation, revisions: revisions.map((entry) => requireRevision(entry)) };
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(table, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function requireRevision(entry: unknown): EgressPolicyRevision {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid egress revision journal: entry is not an object");
  const record = entry as Record<string, unknown>;
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision <= 0) {
    throw new TypeError("invalid egress revision journal: revision must be a positive integer");
  }
  for (const key of ["generation", "ruleId", "host", "approvedAt", "proposedPolicy"] as const) {
    if (typeof record[key] !== "string" || (record[key] as string).trim().length === 0) {
      throw new TypeError(`invalid egress revision journal: ${key} must be a non-empty string`);
    }
  }
  if (record.port !== undefined && (typeof record.port !== "number" || !Number.isInteger(record.port))) {
    throw new TypeError("invalid egress revision journal: port must be an integer when present");
  }
  for (const key of ["methods", "paths"] as const) {
    if (!Array.isArray(record[key]) || (record[key] as unknown[]).some((value) => typeof value !== "string")) {
      throw new TypeError(`invalid egress revision journal: ${key} must be an array of strings`);
    }
  }
  return entry as unknown as EgressPolicyRevision;
}
