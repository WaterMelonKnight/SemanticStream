export interface ResourceAmount {
  readonly frames: number;
  readonly bytes: number;
}

export interface ResourceBudgetLimits {
  readonly windowMs: number;
  readonly maxFrames: number;
  readonly maxBytes: number;
}

export interface ResourceReservation {
  /** Settle at actual delivery time; true only for the first terminal transition. */
  commit(deliveredAtMs: number): boolean;
  release(): boolean;
}

interface Spend extends ResourceAmount {
  readonly timestampMs: number;
}

function validateLimits(limits: ResourceBudgetLimits): void {
  if (!Number.isFinite(limits.windowMs) || limits.windowMs <= 0
    || !Number.isSafeInteger(limits.maxFrames) || limits.maxFrames < 1
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new RangeError('Resource limits require a positive window and positive integer caps.');
  }
}

/** A hold counts against available capacity until it is released or settled. */
export class RollingResourceBudget {
  private readonly entries: Spend[] = [];
  private currentLimits: ResourceBudgetLimits;
  private lastTimestampMs = -Infinity;
  private spentFrames = 0;
  private spentBytes = 0;
  private reservedFrames = 0;
  private reservedBytes = 0;

  constructor(limits: ResourceBudgetLimits) {
    validateLimits(limits);
    this.currentLimits = { ...limits };
  }

  get limits(): ResourceBudgetLimits {
    return { ...this.currentLimits };
  }

  setLimits(limits: ResourceBudgetLimits): void {
    validateLimits(limits);
    if (limits.windowMs !== this.currentLimits.windowMs) {
      throw new RangeError('A rolling resource window is fixed for the lifetime of its ledger.');
    }
    this.currentLimits = { ...limits };
  }

  canSpend(timestampMs: number, frames: number, bytes: number): boolean {
    if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError('Resource amounts require positive integer frames and nonnegative integer bytes.');
    }
    this.advance(timestampMs);
    return frames <= this.currentLimits.maxFrames - this.spentFrames - this.reservedFrames
      && bytes <= this.currentLimits.maxBytes - this.spentBytes - this.reservedBytes;
  }

  reserve(timestampMs: number, frames: number, bytes: number): ResourceReservation | null {
    if (!this.canSpend(timestampMs, frames, bytes)) return null;
    this.reservedFrames += frames;
    this.reservedBytes += bytes;
    let pending = true;
    const release = (): boolean => {
      if (!pending) return false;
      pending = false;
      this.reservedFrames -= frames;
      this.reservedBytes -= bytes;
      return true;
    };
    return {
      release,
      commit: (deliveredAtMs) => {
        if (!pending) return false;
        this.advance(deliveredAtMs);
        release();
        const last = this.entries.at(-1);
        if (last?.timestampMs === deliveredAtMs) {
          this.entries[this.entries.length - 1] = {
            timestampMs: deliveredAtMs, frames: last.frames + frames, bytes: last.bytes + bytes,
          };
        } else {
          this.entries.push({ timestampMs: deliveredAtMs, frames, bytes });
        }
        this.spentFrames += frames;
        this.spentBytes += bytes;
        return true;
      },
    };
  }

  used(timestampMs: number): ResourceAmount {
    this.advance(timestampMs);
    return { frames: this.spentFrames, bytes: this.spentBytes };
  }

  get reserved(): ResourceAmount {
    return { frames: this.reservedFrames, bytes: this.reservedBytes };
  }

  private advance(timestampMs: number): void {
    if (!Number.isFinite(timestampMs) || timestampMs < this.lastTimestampMs) {
      throw new RangeError('Resource timestamps must be finite and nondecreasing.');
    }
    this.lastTimestampMs = timestampMs;
    while (this.entries.length && timestampMs >= this.entries[0].timestampMs + this.currentLimits.windowMs) {
      const expired = this.entries.shift()!;
      this.spentFrames -= expired.frames;
      this.spentBytes -= expired.bytes;
    }
  }
}
