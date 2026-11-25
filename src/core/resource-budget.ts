export interface ResourceAmount {
  readonly frames: number;
  readonly bytes: number;
}

export interface ResourceBudgetLimits {
  readonly windowMs: number;
  readonly maxFrames: number;
  readonly maxBytes: number;
}

interface Spend extends ResourceAmount {
  readonly timestampMs: number;
}

function validateLimits(limits: ResourceBudgetLimits): void {
  if (!Number.isFinite(limits.windowMs) || limits.windowMs <= 0) {
    throw new RangeError('Resource window must be positive and finite.');
  }
  if (!Number.isSafeInteger(limits.maxFrames) || limits.maxFrames < 1) {
    throw new RangeError('Resource frame limit must be a positive integer.');
  }
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new RangeError('Resource byte limit must be a positive integer.');
  }
}

/**
 * Rolling resource ledger used for retrieval-only and combined budgets.
 * Entries are bounded by the configured frame limit; recording more than the
 * limit is allowed so callers can audit an already-performed real-time send,
 * but `canSpend` will reject new work until old entries expire.
 */
export class RollingResourceBudget {
  private readonly entries: Spend[] = [];
  private currentLimits: ResourceBudgetLimits;

  constructor(limits: ResourceBudgetLimits) {
    validateLimits(limits);
    this.currentLimits = limits;
  }

  get limits(): ResourceBudgetLimits {
    return this.currentLimits;
  }

  setLimits(limits: ResourceBudgetLimits): void {
    validateLimits(limits);
    this.currentLimits = limits;
  }

  canSpend(timestampMs: number, frames: number, bytes: number): boolean {
    const used = this.used(timestampMs);
    return used.frames + frames <= this.limits.maxFrames && used.bytes + bytes <= this.limits.maxBytes;
  }

  /** Record an event that already happened (for example, a real-time send). */
  record(timestampMs: number, frames: number, bytes: number): void {
    if (!Number.isFinite(timestampMs)) throw new RangeError('Resource timestamp must be finite.');
    if (!Number.isSafeInteger(frames) || frames < 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError('Resource amounts must be nonnegative integers.');
    }
    this.entries.push({ timestampMs, frames, bytes });
    this.prune(timestampMs);
    // The array is bounded by the largest observed frame limit plus the
    // current window; real-time sends are additionally limited upstream.
    while (this.entries.length > this.limits.maxFrames * 4) this.entries.shift();
  }

  used(timestampMs: number): ResourceAmount {
    this.prune(timestampMs);
    let frames = 0;
    let bytes = 0;
    for (const entry of this.entries) {
      frames += entry.frames;
      bytes += entry.bytes;
    }
    return { frames, bytes };
  }

  clear(): void {
    this.entries.length = 0;
  }

  private prune(timestampMs: number): void {
    const cutoff = timestampMs - this.limits.windowMs;
    while (this.entries.length && this.entries[0].timestampMs < cutoff) this.entries.shift();
  }
}
