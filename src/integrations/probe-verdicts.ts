import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * W078 follow-up — the machine-readable probe verdict register.
 *
 * The dated probe verdicts have lived in prose (`docs/HOST_ADAPTERS.md`,
 * `docs/FEATURES.md`) while the executable gates live in `test/*-probe`
 * files — two sources that can drift: a gate renamed in a test leaves the
 * prose verdict pointing at nothing, and a prose verdict can quietly outlive
 * the probe that earned it. This register is the single durable record both
 * sides can be checked against: host + version of record, probe file, gate
 * env, date, result, the enforcement posture the verdict supports, and the
 * evidence write-up.
 *
 * Fail-closed parsing mirrors the schedule-table discipline: a corrupt or
 * invalid register is an error, never an empty list. `docs/HOST_ADAPTERS.md`
 * remains the human write-up; this register is the machine-checkable layer
 * that doctor renders and the anti-drift test pins against the real test
 * corpus (every registered probe file must exist and name its gate; every
 * gate-style probe file must be registered). Cited evidence is pinned the
 * same way: the repo-relative paths a row's `evidence` names must exist, so a
 * verdict cannot keep pointing at a write-up that was deleted or moved.
 */

export type ProbeVerdictResult = "green" | "red" | "negative" | "pending" | "blocked";

/**
 * The enforcement posture a verdict supports, worded like
 * `docs/HOST_ADAPTERS.md`: `enforced` (probe-proven for the recorded launch
 * mode), `enforced-eligible` (green per probe; enforcement rides operator
 * policy/config being pinned), `advisory` (no enforcement claim earned),
 * `spawn-denied` (advisory cap for spawn-inclusive workflows), and
 * `unqualified` (nothing decided — the probe family has never run).
 */
export type ProbePosture = "enforced" | "enforced-eligible" | "advisory" | "spawn-denied" | "unqualified";

export interface ProbeVerdictRecord {
  /** Stable slug, unique across the register (`acp-opencode-subagent`). */
  readonly id: string;
  /** The host family (opencode, goose, cline, …). */
  readonly host: string;
  /** Version of record — the exact version the probe measured. */
  readonly hostVersion: string;
  /** The gated probe file, repo-relative (`test/acp-…-probe.test.ts`). */
  readonly probe: string;
  /** The gate env that arms the probe (`WORKFLOW_ACP_OPENCODE_SUBAGENT`). */
  readonly gate: string;
  /** Date the recorded verdict was earned (YYYY-MM-DD). */
  readonly date: string;
  /**
   * `green` — the probe ran and its invariants held; `red` — the probe ran
   * and an invariant tripped (the unsafe finding); `negative` — the probe
   * ran and the mechanism under test is absent (a documented finding, not a
   * safety trip); `pending` — the gate exists but no live verdict is
   * recorded; `blocked` — the probe cannot run without operator
   * environment/credentials, named in `blocker`.
   */
  readonly result: ProbeVerdictResult;
  readonly posture: ProbePosture;
  /** Where the dated verdict is written up (doc + section/row). */
  readonly evidence: string;
  /** Required for `blocked`: the missing operator environment/credential. */
  readonly blocker?: string;
  /** Supersession and caveats (e.g. a removed pinned surface). */
  readonly note?: string;
}

export interface ProbeVerdictRegister {
  readonly version: number;
  /** Date the register itself was last updated (YYYY-MM-DD). */
  readonly updated: string;
  readonly verdicts: readonly ProbeVerdictRecord[];
}

/** Package root: two levels up from this module (src|dist/integrations → root). */
export function probeVerdictsPackageRoot(importUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(importUrl)), "..", "..");
}

/** The register document lives with the other docs of record. */
export function probeVerdictsPath(root: string): string {
  return join(root, "docs", "PROBE_VERDICTS.json");
}

const PROBE_PATTERN = /^test\/[A-Za-z0-9._/-]+\.test\.ts$/;
const GATE_PATTERN = /^WORKFLOW_[A-Z0-9_]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The repo-relative paths a row's free-text `evidence` may cite, e.g.
 * `docs/HOST_ADAPTERS.md remote bridge entry; test/acp-remote-sse-probe.test.ts
 * header`. The extension allowlist is what keeps version strings (`2.0.10`),
 * section marks (`§11`) and API routes (`/api/event`) out of the citation
 * set; the leading lookbehind keeps the tail of an absolute path from being
 * read as a repo-relative one; the trailing guard plus the extension
 * alternation mean a sentence-final period is not part of the path (the
 * `test/opencode-v2-route-class.test.ts.` citation resolves as-is).
 *
 * Documented limit: a citation written in a shape this pattern does not
 * recognize (a bare filename with no extension, a Windows separator) is left
 * unpinned, not mis-resolved — the check never invents a path to fail on.
 */
const CITED_PATH_PATTERN = /(?<![\w./-])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:md|mdx|json|ts|tsx|mjs|js|txt|yaml|yml))(?![\w/])/g;

/** The distinct repo-relative paths an `evidence` string cites. */
function citedEvidencePaths(evidence: string): string[] {
  return [...new Set([...evidence.matchAll(CITED_PATH_PATTERN)].map((match) => match[1]!))];
}

const RESULTS: readonly string[] = ["green", "red", "negative", "pending", "blocked"];
const POSTURES: readonly string[] = ["enforced", "enforced-eligible", "advisory", "spawn-denied", "unqualified"];

export interface ValidateProbeVerdictsOptions {
  /** Existence check for the referenced probe file (injectable for tests). */
  readonly exists?: (path: string) => boolean;
  /** Repo root the probe paths resolve against (defaults to the package root). */
  readonly root?: string;
}

/**
 * Validates one parsed register document, fail-closed: a wrong version, a
 * malformed record, an unknown result/posture, a non-ISO date, a duplicate
 * id, a probe path that is not a test file or does not exist on disk, a cited
 * evidence path that does not exist, or a `blocked` entry without its blocker
 * all throw. The probe existence check is the runtime side of anti-drift: a
 * register row pointing at a deleted probe is an error, not a stale claim —
 * and the evidence check extends that to the write-up it cites.
 */
export function validateProbeVerdictRegister(parsed: unknown, options: ValidateProbeVerdictsOptions = {}): ProbeVerdictRegister {
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("invalid probe verdict register: not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new TypeError("invalid probe verdict register: unsupported or missing version");
  }
  if (typeof record.updated !== "string" || !DATE_PATTERN.test(record.updated)) {
    throw new TypeError("invalid probe verdict register: updated must be a YYYY-MM-DD date");
  }
  if (!Array.isArray(record.verdicts) || record.verdicts.length === 0) {
    throw new TypeError("invalid probe verdict register: verdicts must be a non-empty array");
  }
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const root = options.root ?? probeVerdictsPackageRoot();
  const seen = new Set<string>();
  const verdicts = record.verdicts.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError(`invalid probe verdict register: verdict ${index} is not an object`);
    }
    const verdict = entry as Record<string, unknown>;
    for (const key of ["id", "host", "hostVersion", "probe", "gate", "date", "evidence"] as const) {
      if (typeof verdict[key] !== "string" || (verdict[key] as string).trim().length === 0) {
        throw new TypeError(`invalid probe verdict register: '${verdict.id ?? index}' — ${key} must be a non-empty string`);
      }
    }
    const id = verdict.id as string;
    if (seen.has(id)) throw new TypeError(`invalid probe verdict register: duplicate id '${id}'`);
    seen.add(id);
    if (!PROBE_PATTERN.test(verdict.probe as string)) {
      throw new TypeError(`invalid probe verdict register: '${id}' — probe must be a repo test path like 'test/x-probe.test.ts'`);
    }
    if (!exists(join(root, verdict.probe as string))) {
      throw new TypeError(`invalid probe verdict register: '${id}' — probe file not found: ${verdict.probe}`);
    }
    // The write-up is pinned too, not just the executable gate: every
    // repo-relative path the row's `evidence` prose cites must still exist, so
    // a verdict cannot outlive the doc (or test) that earned it. A citation
    // that resolves nowhere is drift, and it fails closed like a deleted probe
    // does. Scope is the `evidence` string alone — `blocker`/`note` are
    // operator prose, not a citation surface.
    for (const cited of citedEvidencePaths(verdict.evidence as string)) {
      if (!exists(join(root, cited))) {
        throw new TypeError(`invalid probe verdict register: '${id}' — cited evidence not found: ${cited}`);
      }
    }
    if (!GATE_PATTERN.test(verdict.gate as string)) {
      throw new TypeError(`invalid probe verdict register: '${id}' — gate must be a WORKFLOW_* env name`);
    }
    if (!DATE_PATTERN.test(verdict.date as string)) {
      throw new TypeError(`invalid probe verdict register: '${id}' — date must be YYYY-MM-DD`);
    }
    if (!RESULTS.includes(verdict.result as string)) {
      throw new TypeError(`invalid probe verdict register: '${id}' — result must be one of ${RESULTS.join(", ")}`);
    }
    if (!POSTURES.includes(verdict.posture as string)) {
      throw new TypeError(`invalid probe verdict register: '${id}' — posture must be one of ${POSTURES.join(", ")}`);
    }
    // Optional fields are typed too, fail-closed: a non-string blocker/note
    // is document drift, not a value to pass through.
    for (const key of ["blocker", "note"] as const) {
      if (verdict[key] !== undefined && (typeof verdict[key] !== "string" || (verdict[key] as string).trim().length === 0)) {
        throw new TypeError(`invalid probe verdict register: '${id}' — ${key} must be a non-empty string when present`);
      }
    }
    if (verdict.result === "blocked" && (typeof verdict.blocker !== "string" || (verdict.blocker as string).trim().length === 0)) {
      throw new TypeError(`invalid probe verdict register: '${id}' — a blocked verdict must name its blocker`);
    }
    return verdict as unknown as ProbeVerdictRecord;
  });
  // Dated honesty: the register's own stamp can never predate its newest
  // verdict — ISO dates compare lexicographically, so the string comparison
  // is exact for YYYY-MM-DD.
  const newest = verdicts.reduce((latest, verdict) => (verdict.date > latest ? verdict.date : latest), verdicts[0]!.date);
  if ((record.updated as string) < newest) {
    throw new TypeError(`invalid probe verdict register: updated (${record.updated}) predates the newest verdict date (${newest}) — bump the register stamp when a verdict moves`);
  }
  return { version: 1, updated: record.updated as string, verdicts };
}

/** Loads and validates the register from disk; throws fail-closed on any
 * parse/validation error (ENOENT included — a missing register is drift). */
export function loadProbeVerdicts(options: { root?: string } = {}): ProbeVerdictRegister {
  const root = options.root ?? probeVerdictsPackageRoot();
  let raw: string;
  try {
    raw = readFileSync(probeVerdictsPath(root), "utf8");
  } catch (error) {
    throw new TypeError(
      `cannot read the probe verdict register at ${probeVerdictsPath(root)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`invalid probe verdict register: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return validateProbeVerdictRegister(parsed, { root });
}

/* ---------------------------------------------------------------------------
 * SSE idle-hold classification — the `acp-remote-sse-idle` arm's verdict.
 *
 * The idle arm of `test/acp-remote-sse-probe.test.ts` holds ONE `/api/event`
 * subscription open through a 4-minute window in which no events arrive, and
 * fails only if the ingress dropped the stream or silently resumed it. That
 * decision used to be inline asserts inside the arm, which means the arm's
 * *honest reporting* was pinned by nothing a reviewer or CI can see: the arm
 * runs only under its live gate, for 240 seconds, against a live server. A
 * weakened condition (a dropped-stream check removed, the hold tolerance
 * widened) would have stayed green in every normal run and surfaced only when
 * someone spent four minutes of wall clock to find out.
 *
 * Extracted here, the conditions are a pure function the arm calls and the fast
 * suite decides in milliseconds: a mid-window drop, a second
 * `text/event-stream` subscription (the silent-resume signal), a short hold and
 * a clean 240s hold are all pinned by `test/probe-verdict-sse-idle.test.ts`.
 * One implementation, so the live arm and its unit tests cannot drift.
 * ---------------------------------------------------------------------- */

/**
 * Wall-clock slack before a hold counts as short. The arm sleeps for the whole
 * window, so a timer can land a millisecond or two early; a real truncation
 * (a suspended host, a throttled timer) is orders of magnitude larger. Without
 * this the arm would report probe jitter as a transport finding.
 */
const SSE_IDLE_HOLD_SLACK_MS = 1_000;

/**
 * What an idle hold proves:
 * - `survived` — one subscription was open for the whole window, no drop.
 * - `short-hold` — **probe integrity**, not a transport finding: the window
 *   closed early, so it measured nothing either way. Checked first, because a
 *   cut-short window can manufacture a drop and reporting that as an ingress
 *   failure would be a false finding.
 * - `never-opened` — no `text/event-stream` subscription ever arrived, so there
 *   was no stream to survive. Fail-closed: without this, zero subscriptions
 *   opened and zero seen compare equal and the arm would report a quiet
 *   survival of a stream that never existed.
 * - `dropped` — the ingress ended or errored the stream mid-window.
 * - `resumed` — the subscription count moved during a window the probe never
 *   re-opens, i.e. the engine silently resumed the stream and swallowed the
 *   gap. Also fails on a count that moved the other way: a decreasing counter
 *   is a broken measurement, and a broken measurement is never a pass.
 */
export type SseIdleHoldOutcome = "survived" | "short-hold" | "never-opened" | "dropped" | "resumed";

/** The facts one idle hold is judged on, as the live arm recorded them. */
export interface SseIdleHoldFacts {
  /** Milliseconds the stream was actually held open after the window started. */
  readonly heldMs: number;
  /** The window the arm set out to hold (240_000 for the live arm). */
  readonly idleWindowMs: number;
  /** Events delivered during the window. */
  readonly delivered: number;
  /** `text/event-stream` subscriptions seen in total, at the end of the window. */
  readonly subscriptions: number;
  /** That same count when the window started. */
  readonly openedBefore: number;
  /** Why the event iterator ended or errored, when it did. */
  readonly drop?: string | undefined;
}

export interface SseIdleHoldVerdict {
  readonly outcome: SseIdleHoldOutcome;
  /** True only for `survived`; the live arm asserts on this and `reason`. */
  readonly survived: boolean;
  /** The finding, worded for the probe's failure message. */
  readonly reason: string;
  /** Events delivered during the window. */
  readonly delivered: number;
  /**
   * True when the window was event-free. False is NOT a failure — the stream
   * still survived — but it does mean the idle premise was only partially
   * exercised, so the arm reports it rather than banking it as a clean hold.
   */
  readonly eventFree: boolean;
}

/** Counts are instrumented integers; anything else is a broken measurement. */
function idleHoldCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`invalid SSE idle hold: ${name} must be a non-negative integer (got ${value})`);
  }
  return value;
}

/**
 * Decides one SSE idle hold — the survival decision the `acp-remote-sse-idle`
 * arm makes after its live window. Pure and total: it reads the recorded facts
 * and nothing else, so the conditions that earn (or refuse) a survival verdict
 * are testable without a server, a network, or four minutes of wall clock.
 *
 * Fail-closed on bad facts: a non-finite/negative hold, a non-positive window,
 * or a non-integer counter throws rather than classifying, because a garbled
 * measurement must never be reported as a survival.
 */
export function classifySseIdleHold(facts: SseIdleHoldFacts): SseIdleHoldVerdict {
  if (!Number.isFinite(facts.heldMs) || facts.heldMs < 0) {
    throw new TypeError(`invalid SSE idle hold: heldMs must be a non-negative number of milliseconds (got ${facts.heldMs})`);
  }
  if (!Number.isFinite(facts.idleWindowMs) || facts.idleWindowMs <= 0) {
    throw new TypeError(`invalid SSE idle hold: idleWindowMs must be a positive number of milliseconds (got ${facts.idleWindowMs})`);
  }
  const delivered = idleHoldCount("delivered", facts.delivered);
  const subscriptions = idleHoldCount("subscriptions", facts.subscriptions);
  const openedBefore = idleHoldCount("openedBefore", facts.openedBefore);
  const verdict = (outcome: SseIdleHoldOutcome, reason: string): SseIdleHoldVerdict => ({
    outcome,
    survived: outcome === "survived",
    reason,
    delivered,
    eventFree: delivered === 0,
  });

  // Probe integrity first: a short hold proves nothing, and reporting it
  // before a transport finding keeps a cut-short window from being reported as
  // an ingress drop it may have manufactured.
  if (facts.heldMs < facts.idleWindowMs - SSE_IDLE_HOLD_SLACK_MS) {
    return verdict(
      "short-hold",
      `the window closed after ${facts.heldMs}ms of ${facts.idleWindowMs}ms — a short hold proves nothing`,
    );
  }
  if (openedBefore === 0) {
    return verdict(
      "never-opened",
      `no text/event-stream subscription ever opened, so no stream was measured (${delivered} event(s) delivered over ${facts.heldMs}ms)`,
    );
  }
  if (facts.drop !== undefined) {
    return verdict("dropped", `the ingress dropped the idle stream: ${facts.drop}`);
  }
  if (subscriptions !== openedBefore) {
    return verdict(
      "resumed",
      `the stream silently resumed: ${subscriptions} SSE subscriptions during one idle window (${openedBefore} at the start)`,
    );
  }
  return verdict(
    "survived",
    `one SSE subscription held ${facts.heldMs}ms through the ${facts.idleWindowMs}ms window, ${delivered === 0 ? "no events" : `${delivered} event(s)`} delivered`,
  );
}