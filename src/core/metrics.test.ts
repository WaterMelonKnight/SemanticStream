import { describe, expect, it } from 'vitest';
import { MetricsCollector } from './metrics';

describe('metrics collector', () => {
  it('counts every filtered reason separately from accepted frames', () => {
    const metrics = new MetricsCollector();
    metrics.record('sent', 2);
    metrics.record('policy', 1);
    metrics.record('interval', 1);
    metrics.record('budget', 1);
    metrics.record('backpressure', 1);
    metrics.record('sent', 4);

    expect(metrics.snapshot()).toEqual({
      inputs: 6,
      sent: 2,
      filteredPercent: (100 * 4) / 6,
      meanProcessingMs: 10 / 6,
      reasons: { policy: 1, interval: 1, budget: 1, backpressure: 1 },
    });
  });

  it('returns an empty, zeroed snapshot before any input', () => {
    expect(new MetricsCollector().snapshot()).toEqual({
      inputs: 0,
      sent: 0,
      filteredPercent: 0,
      meanProcessingMs: 0,
      reasons: { policy: 0, interval: 0, budget: 0, backpressure: 0 },
    });
  });

  it('returns a copy so later records do not mutate an earlier snapshot', () => {
    const metrics = new MetricsCollector();
    metrics.record('policy', 0);
    const first = metrics.snapshot();
    metrics.record('budget', 0);
    expect(first.reasons).toEqual({ policy: 1, interval: 0, budget: 0, backpressure: 0 });
    expect(metrics.snapshot().reasons).toEqual({ policy: 1, interval: 0, budget: 1, backpressure: 0 });
  });
});
