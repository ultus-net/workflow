import type { OperatorSessionItem } from "../operator-session.js";

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
