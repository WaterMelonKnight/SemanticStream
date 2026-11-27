import { describe, expect, it } from 'vitest';
import { runTrackingBenchmark, trackingReport } from './object-tracking-benchmark';

describe('synthetic tracking benchmark', () => {
  it('runs deterministic fixtures and reports bounded/indexed results', () => {
    const results = runTrackingBenchmark();
    expect(results).toHaveLength(10);
    const moving = results.find((result) => result.name === 'moving-object');
    expect(moving?.idSwitches).toBe(0);
    expect(moving?.associationCorrect).toBe(moving?.associationTotal);
    expect(moving?.indexEntries).toBe(1);
    const low = results.find((result) => result.name === 'low-confidence');
    expect(low?.events).toEqual([]);
    const skipped = results.find((result) => result.name === 'skipped-vs-empty');
    expect(skipped?.eventRecall).toBe(1);
    const session = results.find((result) => result.name === 'session-switch');
    expect(session?.associationCorrect).toBe(session?.associationTotal);
    expect(trackingReport(results)).toContain('Synthetic ObjectObservation fixtures only');
  });
});
