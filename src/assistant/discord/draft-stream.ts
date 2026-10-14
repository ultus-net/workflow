/**
 * Progressive-edit throttle (pure). Discord rate-limits message edits, so a
 * draft message is only edited when at least `minIntervalMs` has elapsed since
 * the last edit. The clock is injectable so a test can drive it without
 * waiting.
 */

export interface DraftStreamOptions {
  /** Minimum milliseconds between two edits. */
  readonly minIntervalMs: number;
  /** Monotonic clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Tracks the last edit time for one draft message and answers whether another
 * edit is due. `markEdited` records the current time; `shouldEdit` is true when
 * no edit has happened yet or `minIntervalMs` has elapsed since the last one.
 */
export class DraftStream {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private _lastEditAt: number | undefined;

  constructor(options: DraftStreamOptions) {
    this.minIntervalMs = options.minIntervalMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** The timestamp of the last edit, or `undefined` when none has happened. */
  get lastEditAt(): number | undefined {
    return this._lastEditAt;
  }

  /**
   * Whether an edit is due. True when no edit has happened or at least
   * `minIntervalMs` has elapsed since the last edit.
   */
  shouldEdit(now?: number): boolean {
    if (this._lastEditAt === undefined) return true;
    const at = now ?? this.now();
    return at - this._lastEditAt >= this.minIntervalMs;
  }

  /** Record an edit at `now` (defaults to the injected clock). */
  markEdited(now?: number): void {
    this._lastEditAt = now ?? this.now();
  }
}
