import type { LatencyStats, PerceptionStats } from './types';

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function latencyStats(values: readonly number[]): LatencyStats {
  if (!values.length) return { count: 0, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    meanMs: total / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

export class PerceptionMetrics {
  private startedAtMs: number;
  private lastCompletedAtMs: number | null = null;
  private batches = 0;
  private observations = 0;
  private droppedQueue = 0;
  private droppedStale = 0;
  private skippedNotReady = 0;
  private readonly latencies: number[] = [];

  constructor(now: number) {
    this.startedAtMs = now;
  }

  reset(now: number): void {
    this.startedAtMs = now;
    this.lastCompletedAtMs = null;
    this.batches = 0;
    this.observations = 0;
    this.droppedQueue = 0;
    this.droppedStale = 0;
    this.skippedNotReady = 0;
    this.latencies.length = 0;
  }

  recordBatch(inferenceMs: number, observations: number, completedAtMs: number): void {
    this.batches += 1;
    this.observations += observations;
    this.lastCompletedAtMs = completedAtMs;
    this.latencies.push(inferenceMs);
    if (this.latencies.length > 500) this.latencies.shift();
  }

  recordQueueDrop(count = 1): void {
    this.droppedQueue += count;
  }

  recordStale(count = 1): void {
    this.droppedStale += count;
  }

  recordNotReady(count = 1): void {
    this.skippedNotReady += count;
  }

  snapshot(now: number, longTasks: number, maxLongTaskMs: number | null): PerceptionStats {
    const end = this.lastCompletedAtMs ?? now;
    const elapsedMs = Math.max(0, end - this.startedAtMs);
    return {
      batches: this.batches,
      observations: this.observations,
      droppedQueue: this.droppedQueue,
      droppedStale: this.droppedStale,
      skippedNotReady: this.skippedNotReady,
      effectiveFps: elapsedMs > 0 ? (1_000 * this.batches) / elapsedMs : 0,
      latency: latencyStats(this.latencies),
      longTasks,
      maxLongTaskMs,
      elapsedMs,
    };
  }
}

export class LongTaskMonitor {
  private countValue = 0;
  private maxValue: number | null = null;
  private observer: PerformanceObserver | undefined;

  constructor() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.countValue += 1;
          this.maxValue = Math.max(this.maxValue ?? 0, entry.duration);
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch {
      this.observer = undefined;
    }
  }

  get supported(): boolean {
    return this.observer !== undefined;
  }

  get count(): number {
    return this.countValue;
  }

  get maxMs(): number | null {
    return this.maxValue;
  }

  reset(): void {
    this.countValue = 0;
    this.maxValue = null;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}
