import type { OperatorSessionItem } from "../operator-session.js";
import type { WebConfigOption } from "../web-config-options.js";
import type { ProviderReadRecord } from "../../integrations/issue-detail.js";

/**
 * W161: the external provider's poll cadence is its OWN lane, deliberately
 * not the 1.5s panel poll — a primary management seat polling GitHub at
 * ~2,400 requests/hour per open tab would burn the provider quota that the
 * dashboard's own roadmap (iterations 2+) depends on. 30s per open tab keeps
 * an ordinary session near ~120 req/hour, far inside the provider's
 * authenticated ceiling. Lives here (not app.tsx) so the board view's
 * honesty span renders the SAME constant the poll uses — a cadence change
 * can never silently desync the rendered claim. (Residual for a later
 * iteration: hub-side ETag conditional requests so overlapping tabs share
 * one upstream read.)
 */
export const BOARD_POLL_MS = 30_000;

/**
 * W167: the liveness horizon for a recorded provider read. Twice the poll
 * cadence — a read younger than the TTL is "fresh" (the hub has talked to the
 * provider inside this window), beyond it the record is "stale" but still
 * shown. Lives beside BOARD_POLL_MS so the claim and the cadence stay
 * proportioned in one module.
 */
export const BOARD_LIVENESS_TTL_MS = BOARD_POLL_MS * 2;

/** The liveness class a board card's provider link renders from the hub's
 * recorded provider read (and nothing else). */
export type BoardLinkLiveness = "fresh" | "stale" | "requires-auth" | "unreachable";

/** The pill labels, verbatim: "requires auth" states the hub's auth fault in
 * operator language, the other classes speak for themselves. */
export const BOARD_LINK_LIVENESS_LABELS: Readonly<Record<BoardLinkLiveness, string>> = {
  fresh: "fresh",
  stale: "stale",
  "requires-auth": "requires auth",
  unreachable: "unreachable",
};

/**
 * W167: derives the provider link's liveness class from the hub's recorded
 * provider read — and NOTHING else. No record (the hub has performed no
 * provider read, or predates the record) claims no pill; an unparseable
 * recorded instant claims nothing either. A fault record (requires-auth,
 * unreachable) renders verbatim regardless of age — stale means "successful
 * but old", never "broken but old". The TTL boundary is inclusive.
 */
export function boardLinkLiveness(record: ProviderReadRecord | null | undefined, now: number): BoardLinkLiveness | undefined {
  if (record === null || record === undefined) return undefined;
  const at = new Date(record.at).getTime();
  if (Number.isNaN(at)) return undefined;
  if (record.outcome === "requires-auth" || record.outcome === "unreachable") return record.outcome;
  return now - at <= BOARD_LIVENESS_TTL_MS ? "fresh" : "stale";
}

/** Token counts compacted for meters and readouts ("84.5k", "1.2M"). */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * Choice list for a config option, truthful about a current value the agent
 * reports outside its advertised choices: the current value is shown first
 * rather than silently replaced by the nearest known choice.
 */
export function withCurrentChoice(option: WebConfigOption): readonly { readonly value: string; readonly name: string; readonly description?: string }[] {
  const choices = option.choices ?? [];
  const current = String(option.currentValue);
  return choices.some((choice) => choice.value === current)
    ? [...choices]
    : [{ value: current, name: current }, ...choices];
}

/** Session-list timestamps: relative ("5m ago"), full stamp on hover. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * W153: a schedule's next fire, as a short absolute local time ("in 25m" /
 * "tomorrow 09:00" style is deliberately avoided — the countdown phrasing
 * would imply precision the cron match does not have). Machine-readable first:
 * the shared formatter keeps the schedules card and any other next-fire
 * surface consistent.
 */
export function formatScheduleFire(iso: string, now: number = Date.now()): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return iso;
  const minutes = Math.round((target - now) / 60_000);
  if (minutes >= 0 && minutes < 60) return `in ${minutes}m`;
  if (minutes >= 0 && minutes < 60 * 24) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Live activity while a turn runs: the last unfinished tool, or the latest
 * streaming phase. Completed tools are skipped; a poll-tick of staleness at
 * turn start self-corrects on the next projection update.
 */
export function describeActivity(items: readonly OperatorSessionItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.kind === "tool") {
      if (item.status === "in_progress") return item.title;
      if (item.status === "pending") return `${item.title} — awaiting`;
      continue;
    }
    if (item.kind === "thinking") return "thinking…";
    if (item.kind === "assistant") return "writing…";
    if (item.kind === "plan") return "planning…";
  }
  return "working…";
}

/** Elapsed turn time: "45s", then "1m 15s". */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
