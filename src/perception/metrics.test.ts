import { describe, expect, it } from 'vitest';
import { PerceptionMetrics, latencyStats } from './metrics';

describe('perception metrics', () => {
  it('reports P50/P95 and counts bounded batches', () => {
    const stats = latencyStats([10, 20, 30, 40, 100]);
    expect(stats.count).toBe(5);
    expect(stats.p50Ms).toBe(30);
    expect(stats.p95Ms).toBe(100);
    expect(stats.maxMs).toBe(100);
  });

  it('tracks effective detection FPS and dropped work', () => {
    const metrics = new PerceptionMetrics(0);
    metrics.recordQueueDrop(2);
    metrics.recordStale();
    metrics.recordNotReady(3);
    metrics.recordBatch(20, 2, 400);
    metrics.recordBatch(30, 1, 800);
    const stats = metrics.snapshot(1_000, 4, 12);
    expect(stats.batches).toBe(2);
    expect(stats.observations).toBe(3);
    expect(stats.droppedQueue).toBe(2);
    expect(stats.droppedStale).toBe(1);
    expect(stats.skippedNotReady).toBe(3);
    expect(stats.effectiveFps).toBeCloseTo(2.5, 5);
    expect(stats.longTasks).toBe(4);
  });

  it('resets session counters without resetting external long-task state', () => {
    const metrics = new PerceptionMetrics(0);
    metrics.recordBatch(10, 1, 100);
    metrics.reset(1_000);
    const stats = metrics.snapshot(1_000, 1, 50);
    expect(stats.batches).toBe(0);
    expect(stats.elapsedMs).toBe(0);
    expect(stats.longTasks).toBe(1);
  });
});
