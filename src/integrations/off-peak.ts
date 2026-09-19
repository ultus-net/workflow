/**
 * W070a: off-peak scheduling for batch/CI-class work. Both vendors discount
 * deferred usage by 50%, but on different schedules, so the window is modeled
 * per vendor rather than as one global "night" bucket.
 *
 * Verified live 2026-09-19 (see the item's evidence note):
 * - GLM Coding Plan: peak is Monday–Friday 14:00–18:00 Singapore Standard
 *   Time (UTC+8) — i.e. 06:00–10:00 UTC — and everything else (including all
 *   weekend) is off-peak at 0.5× points.
 * - DeepSeek: off-peak rates are 50% lower than peak, but the exact hours are
 *   published only as an image in the pricing update, so they are NOT guessed
 *   here. Supply `WORKFLOW_OFF_PEAK_DEEPSEEK_PEAK_UTC` (e.g. `00:30-16:30`)
 *   to enable DeepSeek deferral; without it the window is `undefined` and the
 *   scheduler fails open (fires and logs the gap) rather than deferring
 *   forever.
 *
 * All arithmetic is UTC and injectable for deterministic tests.
 */

export type OffPeakVendor = "deepseek" | "glm";

export interface PeakWindow {
  /** Inclusive start, minutes since 00:00 UTC. */
  readonly startMinute: number;
  /** Exclusive end, minutes since 00:00 UTC. */
  readonly endMinute: number;
  /** UTC day-of-week numbers (0 = Sunday). Empty means every day. */
  readonly days: readonly number[];
}

export interface OffPeakSpec {
  readonly vendor: OffPeakVendor;
  readonly peak: readonly PeakWindow[];
  /** `"always"` when off-peak is the complement of the peak windows. */
  readonly weekendFree: boolean;
  readonly verifiedOn: string;
  readonly source: string;
}

/**
 * GLM peak: Mon–Fri 14:00–18:00 SGT = Mon–Fri 06:00–10:00 UTC. The complement
 * (including weekends) is off-peak.
 */
export const GLM_OFF_PEAK: OffPeakSpec = {
  vendor: "glm",
  peak: [{ startMinute: 6 * 60, endMinute: 10 * 60, days: [1, 2, 3, 4, 5] }],
  weekendFree: true,
  verifiedOn: "2026-09-19",
  source: "https://docs.z.ai/devpack (peak: Monday–Friday 14:00–18:00 Singapore Standard Time (UTC+8); off-peak 0.5×)",
};

function parseHhMm(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (match === null) throw new TypeError(`off-peak window must be HH:MM-HH:MM in UTC, got ${JSON.stringify(value)}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Parses `"HH:MM-HH:MM"` UTC into a peak window covering every day. */
export function parseUtcPeakWindow(value: string): PeakWindow {
  const parts = value.split("-");
  if (parts.length !== 2) throw new TypeError(`off-peak window must be HH:MM-HH:MM in UTC, got ${JSON.stringify(value)}`);
  const startMinute = parseHhMm(parts[0] ?? "");
  const endMinute = parseHhMm(parts[1] ?? "");
  // A window that wraps midnight (e.g. 22:00-06:00) is split by the caller;
  // reject an inverted same-day window so misconfiguration fails loudly.
  if (endMinute <= startMinute) throw new TypeError(`off-peak peak window must not wrap midnight: ${JSON.stringify(value)}`);
  return { startMinute, endMinute, days: [] };
}

export function deepseekOffPeakSpec(env: NodeJS.ProcessEnv = process.env): OffPeakSpec | undefined {
  const raw = env.WORKFLOW_OFF_PEAK_DEEPSEEK_PEAK_UTC?.trim();
  if (raw === undefined || raw === "") return undefined;
  return {
    vendor: "deepseek",
    peak: [parseUtcPeakWindow(raw)],
    weekendFree: false,
    verifiedOn: "2026-09-19",
    source: "https://api-docs.deepseek.com/news/news260813 (off-peak 50% lower; exact hours published as an image, operator-provided)",
  };
}

export function offPeakSpec(vendor: OffPeakVendor, env: NodeJS.ProcessEnv = process.env): OffPeakSpec | undefined {
  return vendor === "glm" ? GLM_OFF_PEAK : deepseekOffPeakSpec(env);
}

/**
 * Whether `date` falls in the off-peak window for a vendor. `undefined` means
 * the window is unknown (DeepSeek without an operator-provided window): the
 * scheduler must fail open rather than defer indefinitely.
 */
export function isOffPeak(vendor: OffPeakVendor, date: Date, spec: OffPeakSpec | undefined = offPeakSpec(vendor)): boolean | undefined {
  if (spec === undefined) return undefined;
  const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  const day = date.getUTCDay();
  for (const window of spec.peak) {
    const dayApplies = window.days.length === 0 || window.days.includes(day);
    if (dayApplies && minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute) return false;
  }
  return true;
}
