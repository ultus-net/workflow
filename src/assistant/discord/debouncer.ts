/**
 * Per-key debouncer (pure, no leaked timers). Rapid `schedule` calls for the
 * same key coalesce to the LAST `run`; the earlier scheduled runs are dropped.
 *
 * The clock and timer primitives are injectable so a test can drive the delay
 * deterministically instead of waiting in real time. In production the
 * defaults are `Date.now` and `setTimeout`/`clearTimeout`.
 */

export interface DebouncerOptions {
  /** Delay in milliseconds before a scheduled run fires. */
  readonly delayMs: number;
  /** Monotonic clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Timer primitive; defaults to `setTimeout`. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  /** Timer cancellation; defaults to `clearTimeout`. */
  readonly clearTimer?: (handle: unknown) => void;
}

interface Pending {
  readonly handle: unknown;
  readonly run: () => Promise<void>;
}

/**
 * Debounces promises keyed by an opaque string. A key holds at most one pending
 * run. `schedule` replaces any pending run for that key; `cancel` and
 * `cancelAll` drop pending runs without invoking them.
 */
export class Debouncer {
  private readonly delayMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly pending = new Map<string, Pending>();

  constructor(options: DebouncerOptions) {
    this.delayMs = options.delayMs;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Schedule `run` for `key` after `delayMs`. A prior pending run for the same
   * key is cancelled first, so only the last scheduled run fires. The run is
   * invoked with `void` (its rejection is the caller's to observe).
   */
  schedule(key: string, run: () => Promise<void>): void {
    const existing = this.pending.get(key);
    if (existing !== undefined) this.clearTimer(existing.handle);
    const handle = this.setTimer(() => {
      this.pending.delete(key);
      void run();
    }, this.delayMs);
    this.pending.set(key, { handle, run });
  }

  /** Cancel the pending run for `key`, if any. Does not invoke it. */
  cancel(key: string): void {
    const existing = this.pending.get(key);
    if (existing === undefined) return;
    this.clearTimer(existing.handle);
    this.pending.delete(key);
  }

  /** Cancel every pending run. Does not invoke any of them. */
  cancelAll(): void {
    for (const [key] of this.pending) this.cancel(key);
  }
}
