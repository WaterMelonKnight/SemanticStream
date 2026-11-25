import { RollingResourceBudget } from './resource-budget';
import type { ResourceBudgetLimits } from './resource-budget';

export interface ResourceAdmissionConfig {
  readonly realtime: ResourceBudgetLimits;
  readonly retrieval: ResourceBudgetLimits;
  readonly total: ResourceBudgetLimits;
}

export interface ResourceSnapshot {
  readonly usedFrames: number;
  readonly usedBytes: number;
  readonly maxFrames: number;
  readonly maxBytes: number;
  readonly windowMs: number;
}

export interface ResourceAdmissionSnapshot {
  readonly realtime: ResourceSnapshot;
  readonly retrieval: ResourceSnapshot;
  readonly total: ResourceSnapshot;
}

export interface DeliveryAdmission {
  canSend(timestampMs: number, bytes: number): boolean;
  record(timestampMs: number, bytes: number): void;
}

/**
 * One ex-ante admission point for real-time sends and active retrieval.
 * Real-time and retrieval remain separate sub-budgets, but both must also fit
 * the combined total. The sampler's own BudgetController still enforces its
 * rolling frame cap; this controller adds the shared resource gate.
 */
export class ResourceAdmissionController implements DeliveryAdmission {
  private readonly realtimeBudget: RollingResourceBudget;
  private readonly retrievalBudget: RollingResourceBudget;
  private readonly totalBudget: RollingResourceBudget;

  constructor(config: ResourceAdmissionConfig) {
    if (config.realtime.windowMs !== config.retrieval.windowMs
      || config.realtime.windowMs !== config.total.windowMs) {
      throw new RangeError('All admission budgets must use the same rolling window.');
    }
    this.realtimeBudget = new RollingResourceBudget(config.realtime);
    this.retrievalBudget = new RollingResourceBudget(config.retrieval);
    this.totalBudget = new RollingResourceBudget(config.total);
  }

  canSend(timestampMs: number, bytes: number): boolean {
    return this.realtimeBudget.canSpend(timestampMs, 1, bytes)
      && this.totalBudget.canSpend(timestampMs, 1, bytes);
  }

  record(timestampMs: number, bytes: number): void {
    this.realtimeBudget.record(timestampMs, 1, bytes);
    this.totalBudget.record(timestampMs, 1, bytes);
  }

  canRetrieve(timestampMs: number, frames: number, bytes: number): boolean {
    return this.retrievalBudget.canSpend(timestampMs, frames, bytes)
      && this.totalBudget.canSpend(timestampMs, frames, bytes);
  }

  recordRetrieval(timestampMs: number, frames: number, bytes: number): void {
    this.retrievalBudget.record(timestampMs, frames, bytes);
    this.totalBudget.record(timestampMs, frames, bytes);
  }

  setRealtimeFrameLimit(maxFrames: number): void {
    this.realtimeBudget.setLimits({ ...this.realtimeBudget.limits, maxFrames });
  }

  setTotalFrameLimit(maxFrames: number): void {
    this.totalBudget.setLimits({ ...this.totalBudget.limits, maxFrames });
  }

  snapshot(nowMs: number): ResourceAdmissionSnapshot {
    const realtime = this.realtimeBudget.used(nowMs);
    const retrieval = this.retrievalBudget.used(nowMs);
    const total = this.totalBudget.used(nowMs);
    return {
      realtime: { usedFrames: realtime.frames, usedBytes: realtime.bytes, ...this.realtimeBudget.limits },
      retrieval: { usedFrames: retrieval.frames, usedBytes: retrieval.bytes, ...this.retrievalBudget.limits },
      total: { usedFrames: total.frames, usedBytes: total.bytes, ...this.totalBudget.limits },
    };
  }
}
