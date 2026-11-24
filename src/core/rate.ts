/**
 * Counts events in a trailing time window. Storage is capped independently of
 * the event rate so an unusually fast source cannot grow the meter without bound.
 */
export class RollingRate {
  private readonly timestamps: number[] = [];
  private firstTimestampMs: number | undefined;

  constructor(
    private readonly windowMs: number,
    private readonly capacity: number,
  ) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('Rate window must be positive and finite.');
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Rate capacity must be a positive integer.');
    }
  }

  record(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) {
      throw new RangeError('Rate timestamps must be finite.');
    }
    this.firstTimestampMs ??= timestampMs;
    this.timestamps.push(timestampMs);
    if (this.timestamps.length > this.capacity) this.timestamps.shift();
  }

  perSecond(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0;
    const cutoff = nowMs - this.windowMs;
    let first = 0;
    while (first < this.timestamps.length && this.timestamps[first] < cutoff) first += 1;
    if (first > 0) this.timestamps.splice(0, first);
    if (!this.timestamps.length) return 0;

    // Before the window fills, divide by the observed span so the first
    // seconds of a stream do not look artificially slow.
    const observedMs = Math.min(this.windowMs, Math.max(500, nowMs - (this.firstTimestampMs ?? nowMs)));
    return (this.timestamps.length * 1_000) / observedMs;
  }

  clear(): void {
    this.timestamps.length = 0;
    this.firstTimestampMs = undefined;
  }
}
