import { RollingResourceBudget } from './resource-budget';
import type { ResourceBudgetLimits, ResourceReservation } from './resource-budget';

export interface ResourceAdmissionConfig {
  readonly realtime: ResourceBudgetLimits;
  readonly retrieval: ResourceBudgetLimits;
  readonly total: ResourceBudgetLimits;
}

export interface ResourceSnapshot extends ResourceBudgetLimits {
  readonly usedFrames: number;
  readonly usedBytes: number;
  readonly reservedFrames: number;
  readonly reservedBytes: number;
}

export interface ResourceAdmissionSnapshot {
  readonly realtime: ResourceSnapshot;
  readonly retrieval: ResourceSnapshot;
  readonly total: ResourceSnapshot;
}

export interface DeliveryAdmission {
  reserveRealtime(timestampMs: number, bytes: number): ResourceReservation | null;
}

/** Atomic sub-budget and total admission within one JavaScript runtime. */
export class ResourceAdmissionController implements DeliveryAdmission {
  private readonly realtimeBudget: RollingResourceBudget;
  private readonly retrievalBudget: RollingResourceBudget;
  private readonly totalBudget: RollingResourceBudget;
  private lastTimestampMs = -Infinity;

  constructor(config: ResourceAdmissionConfig) {
    if (config.realtime.windowMs !== config.retrieval.windowMs
      || config.realtime.windowMs !== config.total.windowMs) {
      throw new RangeError('All admission budgets must use the same rolling window.');
    }
    this.realtimeBudget = new RollingResourceBudget(config.realtime);
    this.retrievalBudget = new RollingResourceBudget(config.retrieval);
    this.totalBudget = new RollingResourceBudget(config.total);
  }

  reserveRealtime(timestampMs: number, bytes: number): ResourceReservation | null {
    return this.reserve(this.realtimeBudget, timestampMs, 1, bytes);
  }

  reserveRetrieval(timestampMs: number, frames: number, bytes: number): ResourceReservation | null {
    return this.reserve(this.retrievalBudget, timestampMs, frames, bytes);
  }

  setRealtimeFrameLimit(maxFrames: number): void {
    this.realtimeBudget.setLimits({ ...this.realtimeBudget.limits, maxFrames });
  }

  setTotalFrameLimit(maxFrames: number): void {
    this.totalBudget.setLimits({ ...this.totalBudget.limits, maxFrames });
  }

  snapshot(nowMs: number): ResourceAdmissionSnapshot {
    this.advance(nowMs);
    const snapshotBudget = (budget: RollingResourceBudget): ResourceSnapshot => {
      const used = budget.used(nowMs);
      const reserved = budget.reserved;
      return {
        ...budget.limits, usedFrames: used.frames, usedBytes: used.bytes,
        reservedFrames: reserved.frames, reservedBytes: reserved.bytes,
      };
    };
    return {
      realtime: snapshotBudget(this.realtimeBudget),
      retrieval: snapshotBudget(this.retrievalBudget),
      total: snapshotBudget(this.totalBudget),
    };
  }

  private reserve(
    lane: RollingResourceBudget, timestampMs: number, frames: number, bytes: number,
  ): ResourceReservation | null {
    this.advance(timestampMs);
    const laneHold = lane.reserve(timestampMs, frames, bytes);
    if (!laneHold) return null;
    const totalHold = this.totalBudget.reserve(timestampMs, frames, bytes);
    if (!totalHold) {
      laneHold.release();
      return null;
    }
    let pending = true;
    return {
      commit: (deliveredAtMs) => {
        if (!pending) return false;
        this.advance(deliveredAtMs);
        laneHold.commit(deliveredAtMs);
        totalHold.commit(deliveredAtMs);
        pending = false;
        return true;
      },
      release: () => {
        if (!pending) return false;
        laneHold.release();
        totalHold.release();
        pending = false;
        return true;
      },
    };
  }

  private advance(timestampMs: number): void {
    if (!Number.isFinite(timestampMs) || timestampMs < this.lastTimestampMs) {
      throw new RangeError('Admission timestamps must be finite and nondecreasing.');
    }
    this.lastTimestampMs = timestampMs;
  }
}
