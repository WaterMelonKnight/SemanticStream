import type { LatencyStats, PerceptionStats, TriggerReason, TriggerReasonCounts } from './types';

const RECENT_WINDOW_MS = 5_000;

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

function emptyTriggerReasons(): TriggerReasonCounts {
  return { fixed: 0, change: 0, periodic: 0, interval: 0, 'below-threshold': 0 };
}

export class PerceptionMetrics {
  private startedAtMs: number;
  private lastCompletedAtMs: number | null = null;
  private batches = 0;
  private submitted = 0;
  private observations = 0;
  private droppedQueue = 0;
  private droppedStale = 0;
  private skippedNotReady = 0;
  private readonly latencies: number[] = [];
  private readonly queueLatencies: number[] = [];
  private readonly completedTimes: number[] = [];
  private readonly inputTimes: number[] = [];
  private readonly triggerReasons: TriggerReasonCounts = emptyTriggerReasons();
  private visible = true;
  private lastVisibilityAtMs: number;
  private foregroundMs = 0;
  private backgroundMs = 0;

  constructor(now: number, visible = true) {
    this.startedAtMs = now;
    this.visible = visible;
    this.lastVisibilityAtMs = now;
  }

  reset(now: number): void {
    this.accumulateVisibility(now);
    this.startedAtMs = now;
    this.lastCompletedAtMs = null;
    this.batches = 0;
    this.submitted = 0;
    this.observations = 0;
    this.droppedQueue = 0;
    this.droppedStale = 0;
    this.skippedNotReady = 0;
    this.latencies.length = 0;
    this.queueLatencies.length = 0;
    this.completedTimes.length = 0;
    this.inputTimes.length = 0;
    Object.assign(this.triggerReasons, emptyTriggerReasons());
    this.lastVisibilityAtMs = now;
  }

  setVisible(visible: boolean, now: number): void {
    if (visible === this.visible) return;
    this.accumulateVisibility(now);
    this.visible = visible;
  }

  private accumulateVisibility(now: number): void {
    const elapsed = Math.max(0, now - this.lastVisibilityAtMs);
    if (this.visible) this.foregroundMs += elapsed;
    else this.backgroundMs += elapsed;
    this.lastVisibilityAtMs = now;
  }

  recordInput(atMs: number): void {
    this.inputTimes.push(atMs);
    this.trimWindow(this.inputTimes, atMs);
    while (this.inputTimes.length > 400) this.inputTimes.shift();
  }

  recordSubmitted(count = 1): void {
    this.submitted += count;
  }

  recordTrigger(reason: TriggerReason): void {
    this.triggerReasons[reason] += 1;
  }

  recordBatch(inferenceMs: number, observations: number, completedAtMs: number, queueMs = 0): void {
    this.batches += 1;
    this.observations += observations;
    this.lastCompletedAtMs = completedAtMs;
    this.latencies.push(inferenceMs);
    if (this.latencies.length > 500) this.latencies.shift();
    this.queueLatencies.push(Math.max(0, queueMs));
    if (this.queueLatencies.length > 500) this.queueLatencies.shift();
    this.completedTimes.push(completedAtMs);
    this.trimWindow(this.completedTimes, completedAtMs);
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
    const recentWindowMs = Math.min(RECENT_WINDOW_MS, Math.max(1, now - this.startedAtMs));
    const recentCompleted = this.completedTimes.filter((at) => at >= now - RECENT_WINDOW_MS).length;
    const recentInputs = this.inputTimes.filter((at) => at >= now - RECENT_WINDOW_MS).length;
    const foregroundMs = this.foregroundMs
      + (this.visible ? Math.max(0, now - this.lastVisibilityAtMs) : 0);
    const backgroundMs = this.backgroundMs
      + (!this.visible ? Math.max(0, now - this.lastVisibilityAtMs) : 0);
    return {
      batches: this.batches,
      submitted: this.submitted,
      observations: this.observations,
      droppedQueue: this.droppedQueue,
      droppedStale: this.droppedStale,
      skippedNotReady: this.skippedNotReady,
      effectiveFps: elapsedMs > 0 ? (1_000 * this.batches) / elapsedMs : 0,
      recentDetectionFps: recentCompleted / (recentWindowMs / 1_000),
      recentInputFps: recentInputs / (recentWindowMs / 1_000),
      triggerReasons: { ...this.triggerReasons },
      foregroundMs,
      backgroundMs,
      visible: this.visible,
      latency: latencyStats(this.latencies),
      queueLatency: latencyStats(this.queueLatencies),
      longTasks,
      maxLongTaskMs,
      longTasksPerMinute: now > this.startedAtMs ? (longTasks * 60_000) / (now - this.startedAtMs) : 0,
      elapsedMs,
    };
  }

  private trimWindow(values: number[], now: number): void {
    const cutoff = now - RECENT_WINDOW_MS;
    while (values.length && values[0] < cutoff) values.shift();
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
